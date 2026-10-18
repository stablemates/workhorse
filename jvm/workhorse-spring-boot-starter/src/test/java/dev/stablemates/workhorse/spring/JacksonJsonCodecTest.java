package dev.stablemates.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.core.json.JsonWriteFeature;
import tools.jackson.databind.json.JsonMapper;

/** The Jackson codec refuses every value that is not JSON (ADR 0103, "Values and durations"). */
class JacksonJsonCodecTest {
  record Shipment(String order, int boxes) {}

  // The application's mapper writes NaN as a string. The codec must still refuse it.
  private final JacksonJsonCodec codec =
      new JacksonJsonCodec(
          JsonMapper.builder().enable(JsonWriteFeature.WRITE_NAN_AS_STRINGS).build());

  @Test
  void refusesNaN() {
    assertThatThrownBy(() -> codec.encode(Double.NaN)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> codec.encode(Map.of("value", Float.NaN)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void refusesInfinity() {
    assertThatThrownBy(() -> codec.encode(Double.POSITIVE_INFINITY))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> codec.encode(List.of(Double.NEGATIVE_INFINITY)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void refusesALoneSurrogate() {
    assertThatThrownBy(() -> codec.encode("a\uD800b")).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> codec.encode(Map.of("k", "\uDC00")))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void refusesALoneSurrogateInAName() {
    assertThatThrownBy(() -> codec.encode(Map.of("\uD800", 1)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void keepsAValidSurrogatePair() {
    assertThat(codec.encode("😀")).isEqualTo("\"😀\"");
  }

  @Test
  void decodesARecord() {
    String json = codec.encode(new Shipment("A-7", 2));
    Shipment decoded = codec.decode(json, Shipment.class);
    assertThat(decoded).isEqualTo(new Shipment("A-7", 2));
  }

  @Test
  void decodesAnUntypedValueAsJacksonDoes() {
    Map<String, Object> decoded =
        codec.decode(
            "{\"small\":1,\"large\":123456789012345678901234567890,\"real\":1.5}", Object.class);
    assertThat(decoded.get("small")).isEqualTo(1);
    assertThat(decoded.get("large")).isEqualTo(new BigInteger("123456789012345678901234567890"));
    assertThat(decoded.get("real")).isEqualTo(1.5);
  }

  @Test
  void refusesTextThatIsNotJson() {
    assertThatThrownBy(() -> codec.decode("NaN", Object.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> codec.decode("{\"order\":1}", List.class))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
