package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Every {@code workhorse.*} property has a description in the configuration metadata. */
class ConfigurationMetadataTest {
  private static Map<String, JsonNode> properties() throws Exception {
    try (InputStream input =
        ConfigurationMetadataTest.class.getResourceAsStream(
            "/META-INF/spring-configuration-metadata.json")) {
      assertThat(input).as("the configuration processor wrote the metadata").isNotNull();
      Map<String, JsonNode> byName = new HashMap<>();
      for (JsonNode property : JsonMapper.builder().build().readTree(input).get("properties")) {
        byName.put(property.get("name").asString(), property);
      }
      return byName;
    }
  }

  @Test
  void everyPropertyHasADescription() throws Exception {
    Map<String, JsonNode> properties = properties();
    assertThat(properties.keySet()).allMatch(name -> name.startsWith("workhorse."));
    assertThat(properties).hasSizeGreaterThanOrEqualTo(25);
    properties.forEach(
        (name, property) ->
            assertThat(property.path("description").asString(""))
                .as("the description of %s", name)
                .isNotBlank());
  }

  @Test
  void theTwoSwitchesAreOffByDefault() throws Exception {
    Map<String, JsonNode> properties = properties();
    assertThat(properties.get("workhorse.worker.enabled").get("defaultValue").asBoolean())
        .isFalse();
    assertThat(properties.get("workhorse.dashboard.enabled").get("defaultValue").asBoolean())
        .isFalse();
  }

  @Test
  void theDefaultQueueListIsRecorded() throws Exception {
    JsonNode queues = properties().get("workhorse.worker.queues").get("defaultValue");
    assertThat(queues.isArray()).isTrue();
    assertThat(queues.get(0).asString()).isEqualTo("default");
  }
}
