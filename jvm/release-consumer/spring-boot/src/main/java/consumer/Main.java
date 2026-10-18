package consumer;

import dev.stablemates.workhorse.Admin;
import dev.stablemates.workhorse.EnqueueOptions;
import dev.stablemates.workhorse.HandlerContext;
import dev.stablemates.workhorse.Queue;
import dev.stablemates.workhorse.TaskDetail;
import dev.stablemates.workhorse.TaskHandler;
import dev.stablemates.workhorse.TaskState;
import dev.stablemates.workhorse.spring.WorkhorseProperties;
import java.lang.reflect.Type;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;

/**
 * Without an argument, prints the file name of the jar that holds the starter. With a PostgreSQL JDBC URL, starts the
 * application with the starter's worker, enqueues one task through the `Queue` bean, waits for its
 * outcome, and prints the task id for the check to read back.
 *
 * <p>The application asks for none of the starter's optional features. So it first refuses a class path that holds one
 * of their modules, and the run proves that the starter starts without them.
 */
@SpringBootApplication
public class Main {
  static final String QUEUE = "release-consumer";
  static final String TASK_TYPE = "release.consumer";
  static final CountDownLatch handled = new CountDownLatch(1);

  /** One class of each optional module of the starter. The starter POM marks each module optional. */
  static final List<String> OPTIONAL_CLASSES =
      List.of(
          "org.springframework.boot.jackson.JacksonComponent",
          "tools.jackson.databind.json.JsonMapper",
          "org.springframework.boot.health.contributor.HealthIndicator",
          "org.springframework.web.filter.OncePerRequestFilter",
          "jakarta.servlet.Filter",
          "io.opentelemetry.api.OpenTelemetry");

  /** The handler bean. The starter registers it with the worker. */
  @Bean
  TaskHandler<Map<String, Object>> releaseConsumerHandler() {
    return new TaskHandler<>() {
      @Override
      public String taskType() {
        return TASK_TYPE;
      }

      @Override
      public Type payloadType() {
        return Map.class;
      }

      @Override
      public Object handle(HandlerContext context, Map<String, Object> payload) {
        handled.countDown();
        return Map.of("echo", payload);
      }
    };
  }

  public static void main(String[] args) throws InterruptedException {
    for (String name : OPTIONAL_CLASSES) {
      try {
        Class.forName(name, false, Main.class.getClassLoader());
        throw new IllegalStateException("the class path holds the optional " + name);
      } catch (ClassNotFoundException expected) {
        // The starter took the module as optional, so the application does not have it.
      }
    }
    System.out.println(
        Path.of(WorkhorseProperties.class.getProtectionDomain().getCodeSource().getLocation().getPath())
            .getFileName());
    if (args.length == 0) return;

    SpringApplication application = new SpringApplication(Main.class);
    application.setDefaultProperties(
        Map.of(
            "spring.datasource.url", args[0],
            "spring.main.banner-mode", "off",
            // The check reads the task id from the last line, so the application logs only warnings.
            "logging.level.root", "warn",
            "workhorse.worker.enabled", "true",
            "workhorse.worker.queues", QUEUE,
            "workhorse.worker.disable-registry", "true",
            "workhorse.worker.poll-interval", "100ms"));
    UUID taskId;
    // Closing the context drains the worker, so the outcome is written before the process ends.
    try (ConfigurableApplicationContext context = application.run()) {
      taskId =
          context
              .getBean(Queue.class)
              .enqueue(
                  TASK_TYPE, Map.of("packaged", true), EnqueueOptions.builder().queue(QUEUE).build())
              .taskId();
      if (!handled.await(60, TimeUnit.SECONDS)) {
        throw new IllegalStateException("the starter's worker ran no handler");
      }
      // The worker records the outcome after the handler returns.
      Admin admin = context.getBean(Admin.class);
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
      TaskDetail task = admin.getTask(taskId).orElseThrow();
      while (task.state() != TaskState.SUCCEEDED && System.nanoTime() < deadline) {
        Thread.sleep(100);
        task = admin.getTask(taskId).orElseThrow();
      }
      if (task.state() != TaskState.SUCCEEDED
          || !Map.of("echo", Map.of("packaged", true)).equals(task.result())) {
        throw new IllegalStateException("task " + taskId + " is " + task.state());
      }
    }
    System.out.println(taskId);
  }
}
