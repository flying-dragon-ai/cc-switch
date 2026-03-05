use cc_switch_lib::Provider;
use serde_json::json;

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

// 测试使用 Mutex 串行化，跨 await 持锁是预期行为
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn model_failover_queue_isolated_by_model_key() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");
    let db = &state.db;

    let provider_a = Provider::with_id("a".to_string(), "A".to_string(), json!({}), None);
    let provider_b = Provider::with_id("b".to_string(), "B".to_string(), json!({}), None);
    let provider_c = Provider::with_id("c".to_string(), "C".to_string(), json!({}), None);

    db.save_provider("claude", &provider_a).expect("save a");
    db.save_provider("claude", &provider_b).expect("save b");
    db.save_provider("claude", &provider_c).expect("save c");

    db.set_failover_queue_for_model("claude", "haiku", &["b".to_string(), "c".to_string()])
        .expect("set haiku queue");
    db.set_failover_queue_for_model("claude", "sonnet", &["a".to_string()])
        .expect("set sonnet queue");

    let haiku_queue = db
        .get_failover_queue_for_model("claude", "haiku")
        .expect("get haiku queue");
    let sonnet_queue = db
        .get_failover_queue_for_model("claude", "sonnet")
        .expect("get sonnet queue");

    assert_eq!(haiku_queue.len(), 2);
    assert_eq!(haiku_queue[0].provider_id, "b");
    assert_eq!(haiku_queue[1].provider_id, "c");

    assert_eq!(sonnet_queue.len(), 1);
    assert_eq!(sonnet_queue[0].provider_id, "a");
}

// 测试使用 Mutex 串行化，跨 await 持锁是预期行为
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn model_failover_available_providers_excludes_existing_queue_members() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");
    let db = &state.db;

    let provider_a = Provider::with_id("a".to_string(), "A".to_string(), json!({}), None);
    let provider_b = Provider::with_id("b".to_string(), "B".to_string(), json!({}), None);
    let provider_c = Provider::with_id("c".to_string(), "C".to_string(), json!({}), None);

    db.save_provider("claude", &provider_a).expect("save a");
    db.save_provider("claude", &provider_b).expect("save b");
    db.save_provider("claude", &provider_c).expect("save c");

    db.set_failover_queue_for_model("claude", "haiku", &["a".to_string(), "b".to_string()])
        .expect("set haiku queue");

    let available = db
        .get_available_providers_for_model_failover("claude", "haiku")
        .expect("get available providers");

    assert_eq!(available.len(), 1);
    assert_eq!(available[0].id, "c");
}

