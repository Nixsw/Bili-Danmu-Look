use super::*;
use serde_json::json;

fn raw(id: u64, uid: u64) -> IncomingDanmuRaw {
    serde_json::from_value(json!({
        "content": format!("M{id}"), "uid": uid, "nickname": format!("观众{uid}"),
        "userLevel": 12, "fanLevel": 8, "guardType": 3, "timestampMs": id
    }))
    .unwrap()
}

fn make_store(per_user_capacity: usize) -> MessageStore {
    let mut store = MessageStore::new(100, per_user_capacity);
    store.set_viewport_sizes(Some(3), Some(3));
    store
}

fn main_ids(store: &MessageStore) -> Vec<u64> {
    store
        .main_visible()
        .iter()
        .map(|message| message.message_id)
        .collect()
}

fn person_ids(store: &MessageStore) -> Vec<u64> {
    store
        .person_panel()
        .visible_messages
        .iter()
        .map(|message| message.message_id)
        .collect()
}

#[test]
fn clearing_read_rows_replaces_the_deleted_anchor_and_cleans_all_indexes() {
    let mut store = make_store(50);
    store.set_connection("已连接！", true);
    for id in 1..=6 {
        store
            .ingest(raw(id, if id % 2 == 1 { 42 } else { 99 }))
            .unwrap();
    }
    for id in [1, 3, 6] {
        store.ack_message(id);
    }
    store.select_user_anchor(3);
    assert_eq!(store.clear_read_messages(), 3);
    assert_eq!(main_ids(&store), [2, 4, 5]);
    assert_eq!(person_ids(&store), [5]);
    assert_eq!(store.anchor_message_id, Some(5));
    assert_eq!(store.snapshot().first_unread_message_id, Some(2));
    assert!(store.snapshot().connected);
    assert_eq!(store.snapshot().main_hidden_newer_count, 0);
    assert_eq!(store.person_panel().hidden_newer_count, 0);
    assert_eq!(store.main_viewport_motion, None);
    assert_eq!(store.by_id.len(), 3);
    assert_eq!(
        store
            .ids_by_uid
            .values()
            .map(|ids| ids.len())
            .sum::<usize>(),
        3
    );
    let revision = store.main_viewport_revision;
    assert_eq!(store.clear_read_messages(), 0);
    assert_eq!(store.main_viewport_revision, revision);
    store.select_user_anchor(3);
    assert_eq!(store.anchor_message_id, Some(5));
}

#[test]
fn cleanup_preserves_surviving_viewport_rows_and_unread_anchor() {
    let mut store = make_store(50);
    for id in 1..=10 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(6);
    store.scroll_main_viewport(5);
    let main_before = main_ids(&store);
    let person_before = person_ids(&store);
    for id in [2, 4, 9] {
        store.ack_message(id);
    }
    assert_eq!(store.clear_read_messages(), 3);
    assert_eq!(main_ids(&store), main_before);
    assert_eq!(person_ids(&store), person_before);
    assert_eq!(store.anchor_message_id, Some(6));
    assert_eq!(store.snapshot().main_hidden_newer_count, 1);
    assert_eq!(store.snapshot().first_unread_message_id, Some(1));
}

#[test]
fn cleanup_can_restore_an_older_unread_anchor_from_main_history() {
    let mut store = make_store(2);
    for id in 1..=6 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(5);
    store.ack_message(5);
    store.ack_message(6);
    assert_eq!(store.clear_read_messages(), 2);
    assert_eq!(store.anchor_message_id, Some(4));
    assert!(person_ids(&store).contains(&4));
    assert!(!store.by_id.contains_key(&5));
    assert!(!store.by_id.contains_key(&6));
    store.select_user_anchor(5);
    assert_eq!(store.anchor_message_id, Some(4));
}

#[test]
fn cleanup_resets_identity_when_the_selected_user_has_no_remaining_messages() {
    let mut store = make_store(50);
    store.ingest(raw(1, 42)).unwrap();
    store.ingest(raw(2, 99)).unwrap();
    store.select_user_anchor(1);
    store.ack_message(1);
    assert_eq!(store.clear_read_messages(), 1);
    assert_eq!(main_ids(&store), [2]);
    let panel = store.person_panel();
    assert_eq!(panel.selected_uid, None);
    assert_eq!(panel.selected_nickname, None);
    assert_eq!(panel.selected_guard_type, None);
    assert_eq!(panel.anchor_message_id, None);
    assert!(panel.visible_messages.is_empty());
    assert!(!store.ids_by_uid.contains_key("42"));
}

#[test]
fn cleanup_keeps_a_valid_short_tail_when_all_visible_rows_were_read() {
    let mut store = make_store(50);
    for id in 1..=8 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.scroll_main_viewport(99);
    for id in [6, 7, 8] {
        store.ack_message(id);
    }
    assert_eq!(store.clear_read_messages(), 3);
    assert_eq!(main_ids(&store), [5]);
    store.jump_main_viewport_to_unread();
    assert_eq!(main_ids(&store), [1, 2, 3]);
}

#[test]
fn clearing_all_releases_every_cache_preserves_connection_and_never_reuses_ids() {
    let mut store = MessageStore::new(10, 5);
    store.set_viewport_sizes(Some(3), Some(2));
    store.set_connection("已连接！", true);
    for id in 1..=9 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(6);
    store.set_person_panel_hover(true);
    assert!(store.snapshot().main_cache_near_full);
    let revision = store.main_viewport_revision;
    assert_eq!(store.clear_all_messages(), 9);
    assert!(store.messages.is_empty() && store.by_id.is_empty() && store.ids_by_uid.is_empty());
    let snapshot = store.snapshot();
    assert!(snapshot.connected);
    assert_eq!(snapshot.connection_status, "已连接！");
    assert_eq!(snapshot.first_unread_message_id, None);
    assert_eq!(snapshot.main_hidden_newer_count, 0);
    assert!(!snapshot.main_cache_near_full);
    assert_eq!(snapshot.main_viewport_motion, None);
    assert!(snapshot.main_viewport_revision > revision);
    assert_eq!(snapshot.person_panel.selected_uid, None);
    assert_eq!(snapshot.person_panel.anchor_message_id, None);
    assert!(!snapshot.person_panel.hover_frozen);
    assert_eq!(store.clear_all_messages(), 0);
    assert_eq!(store.clear_read_messages(), 0);
    let next = store.ingest(raw(10, 42)).unwrap();
    assert_eq!(next.message_id, 10);
    store.ack_message(1);
    store.select_user_anchor(6);
    assert_eq!(main_ids(&store), [10]);
    assert_eq!(store.snapshot().first_unread_message_id, Some(10));
    assert_eq!(store.selected_uid, None);
    store.select_user_anchor(10);
    store.ack_message(10);
    assert_eq!(store.clear_read_messages(), 1);
    assert!(store.messages.is_empty() && store.by_id.is_empty() && store.ids_by_uid.is_empty());
    assert_eq!(store.selected_uid, None);
}
