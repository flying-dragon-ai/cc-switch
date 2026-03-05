use cc_switch_lib::{
    get_available_providers_for_model_failover_test_hook, get_failover_queue_for_model_test_hook,
    set_failover_queue_for_model_test_hook, Provider,
};
use serde_json::json;

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

// 测试使用 Mutex 串行化，跨 await 持锁是预期行为
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn model_failover_queue_commands_round_trip() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");

    let provider_a = Provider::with_id("a".to_string(), "A".to_string(), json!({}), None);
    let provider_b = Provider::with_id("b".to_string(), "B".to_string(), json!({}), None);

    state.db.save_provider("claude", &provider_a).expect("save a");
    state.db.save_provider("claude", &provider_b).expect("save b");

    let queue = vec!["b".to_string(), "a".to_string()];
    set_failover_queue_for_model_test_hook(&state, "claude", "haiku", &queue)
        .await
        .expect("set model queue");

    let actual = get_failover_queue_for_model_test_hook(&state, "claude", "haiku")
        .await
        .expect("get model queue");

    assert_eq!(actual.len(), 2);
    assert_eq!(actual[0].provider_id, "b");
    assert_eq!(actual[1].provider_id, "a");

    let sonnet = get_failover_queue_for_model_test_hook(&state, "claude", "sonnet")
        .await
        .expect("get sonnet queue");
    assert!(sonnet.is_empty());
}

// 测试使用 Mutex 串行化，跨 await 持锁是预期行为
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn model_failover_available_providers_command_excludes_queue_members() {
    let _guard = test_mutex().lock().expect("acquire test mutex");
    reset_test_fs();
    let _home = ensure_test_home();

    let state = create_test_state().expect("create test state");

    let provider_a = Provider::with_id("a".to_string(), "A".to_string(), json!({}), None);
    let provider_b = Provider::with_id("b".to_string(), "B".to_string(), json!({}), None);
    let provider_c = Provider::with_id("c".to_string(), "C".to_string(), json!({}), None);

    state.db.save_provider("claude", &provider_a).expect("save a");
    state.db.save_provider("claude", &provider_b).expect("save b");
    state.db.save_provider("claude", &provider_c).expect("save c");

    set_failover_queue_for_model_test_hook(&state, "claude", "haiku", &["a".to_string()])
        .await
        .expect("set model queue");

    let available = get_available_providers_for_model_failover_test_hook(&state, "claude", "haiku")
        .await
        .expect("get available providers");

    let available_ids = available.into_iter().map(|p| p.id).collect::<Vec<_>>();
    assert_eq!(available_ids.len(), 2);
    assert!(available_ids.contains(&"b".to_string()));
    assert!(available_ids.contains(&"c".to_string()));
}
