use async_trait::async_trait;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use workhorse_worker::{Client, ClientError, Task, Worker};

#[derive(Default)]
struct Fixture {
    calls: Mutex<Vec<&'static str>>,
    tasks: Mutex<Vec<Task>>,
}
#[async_trait]
impl Client for Fixture {
    async fn claim(
        &self,
        _: &str,
        _: &[String],
        _: usize,
        _: i32,
    ) -> Result<Vec<Task>, ClientError> {
        self.calls.lock().unwrap().push("claim");
        Ok(self.tasks.lock().unwrap().drain(..).collect())
    }
    async fn heartbeat(&self, _: &str, _: &String, _: u64, _: i32) -> Result<(), ClientError> {
        self.calls.lock().unwrap().push("heartbeat");
        Ok(())
    }
    async fn cancel_requested(&self, _: &str) -> Result<Vec<String>, ClientError> {
        self.calls.lock().unwrap().push("cancel");
        Ok(vec![])
    }
    async fn complete(&self, _: &str, _: &String, _: u64) -> Result<(), ClientError> {
        self.calls.lock().unwrap().push("complete");
        Ok(())
    }
    async fn retry_or_dead_letter(
        &self,
        _: &str,
        _: &String,
        _: u64,
        _: serde_json::Value,
    ) -> Result<(), ClientError> {
        self.calls.lock().unwrap().push("fail");
        Ok(())
    }
    async fn run_maintenance_v1(&self, _: &str) -> Result<(), ClientError> {
        self.calls.lock().unwrap().push("maintenance");
        Ok(())
    }
    async fn register(&self, _: &str, _: &[String], _: i32, _: i32) -> Result<bool, ClientError> {
        self.calls.lock().unwrap().push("register");
        Ok(false)
    }
    async fn paused(&self, _: &str) -> Result<bool, ClientError> {
        Ok(false)
    }
    async fn deregister(&self, _: &str) -> Result<(), ClientError> {
        self.calls.lock().unwrap().push("deregister");
        Ok(())
    }
}

#[tokio::test]
async fn fixture_exercises_protocol_settlement_and_drain() {
    let fixture = Arc::new(Fixture {
        tasks: Mutex::new(vec![Task {
            id: "task-1".into(),
            queue: "default".into(),
            rank: 10,
            payload: vec![1],
            fence: 7,
        }]),
        ..Default::default()
    });
    let worker = Worker::new(fixture.clone(), "worker-1", vec!["default".into()])
        .with_batch_size(10)
        .with_lease(Duration::from_secs(1));
    worker.start().await.unwrap();
    let leases = worker.poll().await.unwrap();
    worker.dispatch_batch(leases, |_| async { Ok(()) }).await.unwrap();
    worker.maintenance().await.unwrap();
    worker.drain().await.unwrap();
    assert_eq!(
        &*fixture.calls.lock().unwrap(),
        &["register", "claim", "complete", "maintenance", "deregister"]
    );
}
