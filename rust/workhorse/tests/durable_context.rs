use std::time::{Duration, SystemTime};
use workhorse::{
    ChildOutcome, ChildStatus, HandlerContext, Settlement, SettlementBuffer, WaitResult,
};

#[test]
fn checkpoint_replays_without_running_producer() {
    let mut ctx = HandlerContext::<String>::default();
    let mut runs = 0;
    assert_eq!(
        ctx.checkpoint("charge", || {
            runs += 1;
            "receipt".into()
        })
        .unwrap(),
        "receipt"
    );
    assert_eq!(
        ctx.checkpoint("charge", || {
            runs += 1;
            "other".into()
        })
        .unwrap(),
        "receipt"
    );
    assert_eq!(runs, 1);
}

#[test]
fn timers_and_waits_are_idempotent() {
    let mut ctx = HandlerContext::<String>::default();
    let now = SystemTime::UNIX_EPOCH;
    assert!(!ctx.timer("reminder", Duration::from_secs(5), now).fired());
    assert!(ctx
        .timers
        .observe("reminder", now + Duration::from_secs(5))
        .unwrap()
        .fired());
    assert_eq!(ctx.signal("payment"), WaitResult::Pending);
    assert!(ctx.resolve_signal("payment", "paid".into()));
    assert_eq!(ctx.signal("payment"), WaitResult::Resolved("paid".into()));
    assert!(!ctx.resolve_signal("payment", "late".into()));
}

#[test]
fn fan_out_join_keeps_partial_outcomes() {
    let mut ctx = HandlerContext::<String>::default();
    ctx.fan_out(["a", "b", "c"]);
    assert!(ctx.child_complete("a", ChildStatus::Succeeded("A".into())));
    assert!(ctx.child_complete("b", ChildStatus::Failed("boom".into())));
    assert!(ctx.child_complete("c", ChildStatus::Cancelled));
    assert_eq!(
        ctx.children.join(),
        Some(ChildOutcome::Partial {
            succeeded: vec!["A".into()],
            failed: vec!["boom".into()],
            cancelled: 1
        })
    );
}

#[test]
fn progress_keeps_only_latest_and_settles_through_seam() {
    let mut ctx = HandlerContext::<String>::default();
    assert_eq!(ctx.report_progress("10%").sequence, 1);
    assert_eq!(ctx.report_progress("50%").value, "50%");
    assert_eq!(ctx.progress.latest().unwrap().value, "50%");
    let mut sink = SettlementBuffer::default();
    ctx.settle(
        &mut sink,
        Settlement::Progress(ctx.progress.latest().unwrap().clone()),
    )
    .unwrap();
    assert_eq!(sink.entries.len(), 1);
}
