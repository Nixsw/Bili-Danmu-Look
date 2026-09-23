use super::*;
use serde_json::json;

fn raw(id: u64, uid: u64) -> IncomingDanmuRaw {
    serde_json::from_value(json!({
        "content": format!("M{id}"), "uid": uid, "nickname": format!("观众{uid}"),
        "userLevel": 12, "fanLevel": 8, "guardType": 0, "timestampMs": id,
    }))
    .unwrap()
}

fn person_ids(store: &MessageStore) -> Vec<u64> {
    store
        .person_panel()
        .visible_messages
        .iter()
        .map(|message| message.message_id)
        .collect()
}

fn main_ids(store: &MessageStore) -> Vec<u64> {
    store
        .main_visible()
        .iter()
        .map(|message| message.message_id)
        .collect()
}

#[test]
fn arrivals_and_hover_exit_keep_the_person_viewport_stationary() {
    let mut store = MessageStore::new(1000, 50);
    store.person_viewport_size = 5;
    for id in 1..=5 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(5);
    store.ingest(raw(6, 42)).unwrap();
    assert_eq!(person_ids(&store), [1, 2, 3, 4, 5]);
    store.set_person_panel_hover(true);
    store.ingest(raw(7, 42)).unwrap();
    store.set_person_panel_hover(false);
    store.set_viewport_sizes(None, Some(5));
    assert_eq!(person_ids(&store), [1, 2, 3, 4, 5]);
    assert_eq!(store.person_panel().hidden_newer_count, 2);
}

#[test]
fn another_users_trim_does_not_move_the_selected_person() {
    let mut store = MessageStore::new(1000, 5);
    store.person_viewport_size = 2;
    for id in 1..=5 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(4);
    store.scroll_person_viewport(1);
    assert_eq!(person_ids(&store), [4, 5]);
    for id in 6..=20 {
        store.ingest(raw(id, 99)).unwrap();
    }
    assert_eq!(person_ids(&store), [4, 5]);
}

#[test]
fn selecting_old_main_history_restores_a_missing_anchor_in_the_uid_index() {
    let mut store = MessageStore::new(1000, 50);
    store.person_viewport_size = 5;
    for id in 1..=80 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(3);
    assert_eq!(store.anchor_message_id, Some(3));
    assert!(person_ids(&store).contains(&3));
    store.ingest(raw(81, 42)).unwrap();
    assert!(person_ids(&store).contains(&3));
    assert_eq!(store.ids_by_uid["42"].len(), 50);
}

#[test]
fn visible_person_rows_survive_per_user_trimming() {
    let mut store = MessageStore::new(1000, 8);
    store.person_viewport_size = 3;
    for id in 1..=8 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(3);
    let before = person_ids(&store);
    for id in 9..=20 {
        store.ingest(raw(id, 42)).unwrap();
    }
    assert_eq!(person_ids(&store), before);
    assert_eq!(store.person_panel().hidden_newer_count, 5);
}

#[test]
fn bulk_read_keeps_old_messages_read_when_restored_to_the_person_index() {
    let mut store = MessageStore::new(1000, 5);
    store.person_viewport_size = 3;
    for id in 1..=8 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.ack_user_messages("42");
    store.select_user_anchor(1);
    assert!(
        store
            .person_panel()
            .visible_messages
            .iter()
            .find(|message| message.message_id == 1)
            .unwrap()
            .read
    );
}

#[test]
fn hitting_the_configured_limit_evicts_a_rounded_up_tenth() {
    let mut store = MessageStore::new(21, 50);
    store.main_viewport_size = 100;
    for id in 1..=20 {
        store.ingest(raw(id, 42)).unwrap();
    }
    assert_eq!(main_ids(&store).len(), 20);
    store.ingest(raw(21, 42)).unwrap();
    assert_eq!(main_ids(&store), (4..=21).collect::<Vec<_>>());
    store.ingest(raw(22, 42)).unwrap();
    assert_eq!(store.messages.len(), 19);
    assert_eq!(store.main_capacity, 21);
}

#[test]
fn batch_eviction_prefers_old_read_rows_even_when_they_are_not_at_the_front() {
    let mut store = MessageStore::new(20, 50);
    store.main_viewport_size = 100;
    for id in 1..=19 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.ack_message(5);
    store.ack_message(18);
    store.ingest(raw(20, 42)).unwrap();
    assert_eq!(
        main_ids(&store),
        (1..=20)
            .filter(|id| *id != 5 && *id != 18)
            .collect::<Vec<_>>()
    );
    assert_eq!(store.snapshot().first_unread_message_id, Some(1));
}

#[test]
fn oldest_unread_only_fills_the_remainder_of_the_batch() {
    let mut store = MessageStore::new(21, 50);
    store.main_viewport_size = 100;
    for id in 1..=20 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.ack_message(5);
    store.ingest(raw(21, 42)).unwrap();
    assert_eq!(
        main_ids(&store),
        (3..=21).filter(|id| *id != 5).collect::<Vec<_>>()
    );
    assert_eq!(store.snapshot().first_unread_message_id, Some(3));
}

#[test]
fn removing_rows_before_and_after_the_viewports_preserves_their_position() {
    let mut store = MessageStore::new(20, 50);
    store.main_viewport_size = 3;
    store.person_viewport_size = 3;
    for id in 1..=19 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(10);
    store.scroll_main_viewport(7);
    store.ack_message(5);
    store.ack_message(18);
    let before = person_ids(&store);
    store.ingest(raw(20, 42)).unwrap();
    assert_eq!(main_ids(&store), [8, 9, 10]);
    assert_eq!(person_ids(&store), before);
}

#[test]
fn left_viewport_survives_many_full_cache_cycles() {
    let mut store = MessageStore::new(20, 50);
    store.main_viewport_size = 3;
    store.person_viewport_size = 3;
    for id in 1..=10 {
        store.ingest(raw(id, 42)).unwrap();
    }
    store.select_user_anchor(3);
    let before = person_ids(&store);
    for id in 11..=200 {
        store.ingest(raw(id, id)).unwrap();
    }
    assert_eq!(person_ids(&store), before);
    assert!(person_ids(&store).contains(&3));
    assert_eq!(store.by_id.len(), store.messages.len());
    assert!(store.ids_by_uid.len() <= store.messages.len());
    assert!(store.ids_by_uid.values().all(|ids| !ids.is_empty()));
    store.scroll_main_viewport(999);
    assert!(main_ids(&store).contains(&200));
}

#[test]
fn warning_uses_unread_count_and_clears_after_reading_or_eviction() {
    let mut store = MessageStore::new(21, 50);
    for id in 1..=18 {
        store.ingest(raw(id, 42)).unwrap();
    }
    assert!(!store.snapshot().main_cache_near_full);
    store.ingest(raw(19, 42)).unwrap();
    assert!(store.snapshot().main_cache_near_full);
    assert_eq!(
        serde_json::to_value(store.snapshot()).unwrap()["mainCacheNearFull"],
        true
    );
    store.ack_message(19);
    assert!(!store.snapshot().main_cache_near_full);
    store.ingest(raw(20, 42)).unwrap();
    assert!(store.snapshot().main_cache_near_full);
    store.ingest(raw(21, 42)).unwrap();
    assert!(!store.snapshot().main_cache_near_full);
}

#[test]
fn default_capacity_warns_at_900_unread_and_cleans_100_at_1000() {
    let config = crate::app_config::AppConfig::default();
    let mut store = MessageStore::new(config.main_capacity, config.per_user_capacity);
    for id in 1..=899 {
        store.ingest(raw(id, 42)).unwrap();
    }
    assert!(!store.snapshot().main_cache_near_full);
    store.ingest(raw(900, 42)).unwrap();
    assert!(store.snapshot().main_cache_near_full);
    for id in 901..=1000 {
        store.ingest(raw(id, 42)).unwrap();
    }
    assert_eq!(store.messages.len(), 900);
    assert_eq!(store.by_id.len(), 900);
    assert_eq!(store.snapshot().first_unread_message_id, Some(101));
}

#[test]
fn repeated_evictions_and_anchor_switches_leave_no_orphaned_cache_entries() {
    let mut store = MessageStore::new(41, 8);
    store.person_viewport_size = 3;
    for id in 1..=2000 {
        store.ingest(raw(id, id % 7)).unwrap();
        if id % 13 == 0 {
            let message_id = store.messages[store.messages.len() / 2].message_id;
            store.select_user_anchor(message_id);
        }
        if id % 19 == 0 {
            store.ack_user_messages(&(id % 7).to_string());
        }
        assert!(store.messages.len() <= 41);
        assert_eq!(store.by_id.len(), store.messages.len());
        for message in &store.messages {
            assert_eq!(store.by_id[&message.message_id].read, message.read);
        }
        for (uid, ids) in &store.ids_by_uid {
            assert!(!ids.is_empty() && ids.len() <= 8);
            for message_id in ids {
                assert_eq!(&store.by_id[message_id].uid, uid);
            }
        }
        if let Some(anchor_id) = store.anchor_message_id {
            assert!(person_ids(&store).contains(&anchor_id));
        }
    }
}
