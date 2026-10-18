package run.workhorse.examples;

import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import run.workhorse.Queue;

// Enqueue inside `@Transactional` with the Spring Boot starter: guide 200 and the site page about
// enqueue.

// docs:start java-spring-transactional
@Service
class Accounts {
  private final JdbcTemplate jdbc;
  private final Queue queue;

  Accounts(JdbcTemplate jdbc, Queue queue) {
    this.jdbc = jdbc;
    this.queue = queue;
  }

  @Transactional
  public void create(String id, String email) {
    jdbc.update("INSERT INTO account (id, email) VALUES (?, ?)", id, email);
    queue.enqueue("account.created", Map.of("accountId", id));
  }
}
// docs:end
