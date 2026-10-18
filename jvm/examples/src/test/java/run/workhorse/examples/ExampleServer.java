package run.workhorse.examples;

import jakarta.servlet.ServletContext;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.function.Consumer;
import java.util.stream.Stream;
import org.apache.catalina.Context;
import org.apache.catalina.LifecycleException;
import org.apache.catalina.core.StandardContext;
import org.apache.catalina.startup.Tomcat;

/**
 * An embedded Tomcat for the dashboard snippets. The snippet registers its filter on the servlet
 * context while the context starts, and an application servlet answers {@code app} for every other
 * request.
 */
final class ExampleServer implements AutoCloseable {
  private final Tomcat tomcat = new Tomcat();
  private final Path baseDirectory;
  private final int port;

  ExampleServer(Consumer<ServletContext> register) throws IOException, LifecycleException {
    baseDirectory = Files.createTempDirectory("workhorse-examples-tomcat");
    tomcat.setBaseDir(baseDirectory.toString());
    tomcat.setPort(0);
    tomcat.setSilent(true);
    tomcat.getConnector();
    Context context = tomcat.addContext("", baseDirectory.toString());
    ((StandardContext) context).setClearReferencesRmiTargets(false);
    ((StandardContext) context).setClearReferencesThreadLocals(false);
    context.addServletContainerInitializer(
        (classes, servletContext) -> register.accept(servletContext), null);
    Tomcat.addServlet(
        context,
        "app",
        new HttpServlet() {
          private static final long serialVersionUID = 1L;

          @Override
          protected void service(HttpServletRequest request, HttpServletResponse response)
              throws IOException {
            response.setContentType("text/plain");
            response.getOutputStream().write("app".getBytes(StandardCharsets.UTF_8));
          }
        });
    context.addServletMappingDecoded("/", "app");
    tomcat.start();
    port = tomcat.getConnector().getLocalPort();
  }

  /**
   * The status of a {@code GET} for {@code path} with the host {@code ops.example.com} and the
   * header {@code X-User} set to {@code user}, or no such header when {@code user} is empty.
   */
  int get(String path, String user) throws IOException {
    try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
      OutputStream output = socket.getOutputStream();
      String request =
          "GET "
              + path
              + " HTTP/1.1\r\nHost: ops.example.com\r\nConnection: close\r\n"
              + (user.isEmpty() ? "" : "X-User: " + user + "\r\n")
              + "\r\n";
      output.write(request.getBytes(StandardCharsets.US_ASCII));
      output.flush();
      InputStream input = socket.getInputStream();
      String head = new String(input.readAllBytes(), StandardCharsets.ISO_8859_1);
      return Integer.parseInt(head.substring(head.indexOf(' ') + 1, head.indexOf(' ') + 4));
    }
  }

  @Override
  public void close() throws LifecycleException, IOException {
    tomcat.stop();
    tomcat.destroy();
    try (Stream<Path> files = Files.walk(baseDirectory)) {
      files.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
    }
  }
}
