package dev.stablemates.workhorse.dashboard;

import dev.stablemates.workhorse.internal.Json;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * The browser bundle's files by archive path, read from the class path resources next to {@link
 * Dashboard}. Internal to the SDK.
 *
 * <p>The jar carries {@code bundle.json} and the {@code read-surface-*.tar.gz} archive that it
 * names, as {@code pnpm dashboard-bundle:generate} publishes them. The archive is a gzip ustar
 * file.
 */
final class Bundle {
  private static final int BLOCK = 512;

  private Bundle() {}

  /** The manifest as the core's JSON tree. */
  static Map<String, Object> manifest() {
    Map<String, Object> manifest = new HashMap<>();
    Map<String, ? extends Object> parsed =
        Json.object(Json.parse(new String(resource("bundle.json"), StandardCharsets.UTF_8)));
    if (parsed == null) {
      throw new IllegalStateException("the dashboard bundle.json is not an object");
    }
    parsed.forEach(
        (name, value) -> {
          if (value != null) {
            manifest.put(name, value);
          }
        });
    return manifest;
  }

  /** Unpacks the archive that the manifest names. */
  static Map<String, byte[]> files() {
    if (!(manifest().get("archive") instanceof String archive) || archive.contains("/")) {
      throw new IllegalStateException("the dashboard bundle.json names no archive");
    }
    try (InputStream gzip = new GZIPInputStream(new ByteArrayInputStream(resource(archive)))) {
      return untar(gzip.readAllBytes());
    } catch (IOException error) {
      throw new UncheckedIOException("cannot read the dashboard bundle " + archive, error);
    }
  }

  private static Map<String, byte[]> untar(byte[] tar) {
    Map<String, byte[]> files = new HashMap<>();
    int offset = 0;
    while (offset + BLOCK <= tar.length) {
      if (zero(tar, offset)) {
        break;
      }
      String name = field(tar, offset, 100);
      if (new String(tar, offset + 257, 5, StandardCharsets.US_ASCII).equals("ustar")) {
        String prefix = field(tar, offset + 345, 155);
        if (!prefix.isEmpty()) {
          name = prefix + "/" + name;
        }
      }
      String size = field(tar, offset + 124, 12).trim();
      int length = size.isEmpty() ? 0 : Integer.parseInt(size, 8);
      byte type = tar[offset + 156];
      int start = offset + BLOCK;
      if (start + length > tar.length) {
        throw new IllegalStateException("the dashboard bundle archive is truncated");
      }
      if (type == '0' || type == 0) {
        byte[] content = new byte[length];
        System.arraycopy(tar, start, content, 0, length);
        files.put(name.startsWith("./") ? name.substring(2) : name, content);
      }
      offset = start + (length + BLOCK - 1) / BLOCK * BLOCK;
    }
    return Map.copyOf(files);
  }

  private static boolean zero(byte[] tar, int offset) {
    for (int index = offset; index < offset + BLOCK; index++) {
      if (tar[index] != 0) {
        return false;
      }
    }
    return true;
  }

  private static String field(byte[] tar, int offset, int length) {
    int end = offset;
    while (end < offset + length && tar[end] != 0) {
      end++;
    }
    return new String(tar, offset, end - offset, StandardCharsets.UTF_8);
  }

  private static byte[] resource(String name) {
    try (InputStream stream = Bundle.class.getResourceAsStream(name)) {
      if (stream == null) {
        throw new IllegalStateException(
            "the dashboard browser bundle resource " + name + " is not on the class path");
      }
      return stream.readAllBytes();
    } catch (IOException error) {
      throw new UncheckedIOException("cannot read the dashboard resource " + name, error);
    }
  }
}
