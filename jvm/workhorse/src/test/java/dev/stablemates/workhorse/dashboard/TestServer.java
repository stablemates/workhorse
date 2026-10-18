package dev.stablemates.workhorse.dashboard;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.apache.catalina.Context;
import org.apache.catalina.LifecycleException;
import org.apache.catalina.core.StandardContext;
import org.apache.catalina.startup.Tomcat;

/**
 * An embedded Tomcat inside the test: one context that registers the dashboard filter with {@code
 * ServletContext.addFilter} on {@code /*}, as ADR 0103 describes, and a host servlet that answers
 * {@code host} for every other request.
 */
final class TestServer implements AutoCloseable {
  /** One HTTP response. */
  static final class Response {
    private final int status;
    private final Map<String, String> headers;
    private final byte[] body;

    Response(int status, Map<String, String> headers, byte[] body) {
      this.status = status;
      this.headers = headers;
      this.body = body;
    }

    int status() {
      return status;
    }

    String text() {
      return new String(body, StandardCharsets.UTF_8);
    }

    String header(String name) {
      return headers.getOrDefault(name.toLowerCase(Locale.ROOT), "");
    }
  }

  private final Tomcat tomcat = new Tomcat();
  private final Path baseDirectory;
  private final int port;

  TestServer(String contextPath, Dashboard dashboard) throws IOException, LifecycleException {
    baseDirectory = Files.createTempDirectory("workhorse-dashboard-tomcat");
    tomcat.setBaseDir(baseDirectory.toString());
    tomcat.setPort(0);
    tomcat.setSilent(true);
    tomcat.getConnector();
    Context context = tomcat.addContext(contextPath, baseDirectory.toString());
    // The checks need --add-opens, and the test stops the whole server anyway.
    ((StandardContext) context).setClearReferencesRmiTargets(false);
    ((StandardContext) context).setClearReferencesThreadLocals(false);
    Tomcat.addServlet(
        context,
        "host",
        new HttpServlet() {
          private static final long serialVersionUID = 1L;

          @Override
          protected void service(HttpServletRequest request, HttpServletResponse response)
              throws IOException {
            response.setContentType("text/plain");
            response.getOutputStream().write("host".getBytes(StandardCharsets.UTF_8));
          }
        });
    context.addServletMappingDecoded("/*", "host");
    context.addServletContainerInitializer(
        (classes, servletContext) ->
            servletContext
                .addFilter("workhorse-dashboard", dashboard)
                .addMappingForUrlPatterns(
                    EnumSet.of(jakarta.servlet.DispatcherType.REQUEST), false, "/*"),
        null);
    tomcat.start();
    port = tomcat.getConnector().getLocalPort();
  }

  Response get(String path) throws IOException {
    return request("GET", path, Map.of("Host", "localhost:" + port), new byte[0]);
  }

  Response post(String path, String json) throws IOException {
    return request(
        "POST",
        path,
        Map.of(
            "Host",
            "localhost:" + port,
            "Origin",
            "http://localhost:" + port,
            "Content-Type",
            "application/json"),
        json.getBytes(StandardCharsets.UTF_8));
  }

  /**
   * Sends one HTTP/1.1 request over a plain socket, so the test controls every header, including
   * {@code Host} and {@code Origin}, which {@code java.net.http} restricts.
   */
  Response request(String method, String path, Map<String, String> headers, byte[] body)
      throws IOException {
    try (Socket socket = new Socket(java.net.InetAddress.getLoopbackAddress(), port)) {
      socket.setSoTimeout(30_000);
      StringBuilder head = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
      headers.forEach((name, value) -> head.append(name).append(": ").append(value).append("\r\n"));
      if (!headers.containsKey("Content-Length")) {
        head.append("Content-Length: ").append(body.length).append("\r\n");
      }
      head.append("Connection: close\r\n\r\n");
      OutputStream out = socket.getOutputStream();
      out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
      out.write(body);
      out.flush();
      // The request is complete, so the server reads end of stream instead of a declared body
      // that the test never sends.
      socket.shutdownOutput();
      return parse(socket.getInputStream().readAllBytes());
    }
  }

  private static Response parse(byte[] raw) throws IOException {
    int split = indexOf(raw, "\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
    if (split < 0) {
      throw new IOException("incomplete HTTP response");
    }
    String[] lines = new String(raw, 0, split, StandardCharsets.ISO_8859_1).split("\r\n", -1);
    int status = Integer.parseInt(lines[0].split(" ", -1)[1]);
    Map<String, String> headers = new LinkedHashMap<>();
    for (int index = 1; index < lines.length; index++) {
      int colon = lines[index].indexOf(':');
      headers.put(
          lines[index].substring(0, colon).trim().toLowerCase(Locale.ROOT),
          lines[index].substring(colon + 1).trim());
    }
    byte[] rest = java.util.Arrays.copyOfRange(raw, split + 4, raw.length);
    if ("chunked".equalsIgnoreCase(headers.get("transfer-encoding"))) {
      rest = unchunk(rest);
    }
    return new Response(status, headers, rest);
  }

  private static byte[] unchunk(byte[] chunked) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    InputStream in = new java.io.ByteArrayInputStream(chunked);
    while (true) {
      StringBuilder size = new StringBuilder();
      for (int next = in.read(); next != '\n'; next = in.read()) {
        if (next < 0) {
          throw new IOException("truncated chunk");
        }
        if (next != '\r') {
          size.append((char) next);
        }
      }
      int length = Integer.parseInt(size.toString().split(";", -1)[0].trim(), 16);
      if (length == 0) {
        return out.toByteArray();
      }
      out.write(in.readNBytes(length));
      in.skip(2);
    }
  }

  private static int indexOf(byte[] data, byte[] target) {
    outer:
    for (int index = 0; index + target.length <= data.length; index++) {
      for (int offset = 0; offset < target.length; offset++) {
        if (data[index + offset] != target[offset]) {
          continue outer;
        }
      }
      return index;
    }
    return -1;
  }

  int port() {
    return port;
  }

  @Override
  public void close() throws LifecycleException, IOException {
    tomcat.stop();
    tomcat.destroy();
    try (var paths = Files.walk(baseDirectory)) {
      paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
    }
  }
}
