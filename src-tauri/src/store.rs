use crate::models::{
    normalize_incoming, AppSnapshot, DanmuMessage, IncomingDanmuRaw, MainViewportMotion,
    PersonPanelSnapshot,
};
use std::collections::{HashMap, HashSet, VecDeque};

#[cfg(test)]
mod cache_tests;
#[cfg(test)]
mod clear_tests;

#[derive(Clone, Copy)]
struct ViewportResizeOrigin {
    start_index: usize,
    pinned_to_bottom: bool,
}

pub struct MessageStore {
    next_message_id: u64,
    main_capacity: usize,
    per_user_capacity: usize,
    main_viewport_size: usize,
    person_viewport_size: usize,
    main_resize_origin: Option<ViewportResizeOrigin>,
    person_resize_origin: Option<ViewportResizeOrigin>,
    person_history_count: usize,
    main_start_index: usize,
    main_top_aligned: bool,
    main_viewport_revision: u64,
    main_viewport_motion: Option<MainViewportMotion>,
    selected_uid: Option<String>,
    anchor_message_id: Option<u64>,
    person_start_index: usize,
    person_manual_viewport: bool,
    hover_frozen: bool,
    connected: bool,
    connection_status: String,
    messages: VecDeque<DanmuMessage>,
    by_id: HashMap<u64, DanmuMessage>,
    ids_by_uid: HashMap<String, VecDeque<u64>>,
}

impl MessageStore {
    pub fn new(main_capacity: usize, per_user_capacity: usize) -> Self {
        Self {
            next_message_id: 1,
            main_capacity: main_capacity.max(1),
            per_user_capacity: per_user_capacity.max(1),
            main_viewport_size: 22,
            person_viewport_size: 14,
            main_resize_origin: None,
            person_resize_origin: None,
            person_history_count: 1,
            main_start_index: 0,
            main_top_aligned: false,
            main_viewport_revision: 0,
            main_viewport_motion: None,
            selected_uid: None,
            anchor_message_id: None,
            person_start_index: 0,
            person_manual_viewport: false,
            hover_frozen: false,
            connected: false,
            connection_status: "未连接".to_string(),
            messages: VecDeque::new(),
            by_id: HashMap::new(),
            ids_by_uid: HashMap::new(),
        }
    }

    pub fn ingest(&mut self, raw: IncomingDanmuRaw) -> Result<DanmuMessage, String> {
        let keep_main_pinned_to_bottom = self
            .main_resize_origin
            .map(|origin| origin.pinned_to_bottom)
            .unwrap_or_else(|| self.is_main_viewport_at_bottom());
        let protected_person_ids = self.protected_person_ids();
        let message = normalize_incoming(raw, self.next_message_id)?;
        self.reset_resize_origins();
        self.next_message_id += 1;
        self.messages.push_back(message.clone());
        self.by_id.insert(message.message_id, message.clone());
        self.ids_by_uid
            .entry(message.uid.clone())
            .or_default()
            .push_back(message.message_id);

        self.trim_main_capacity(&protected_person_ids);
        self.trim_user_capacity(&message.uid, &protected_person_ids);
        if keep_main_pinned_to_bottom {
            self.pin_main_viewport_to_bottom();
        } else {
            self.clamp_main_viewport_start();
        }
        Ok(message)
    }

    pub fn ack_main_message(&mut self, message_id: u64) {
        if self.first_unread().map(|message| message.message_id) == Some(message_id) {
            self.ack_message(message_id);
        }
    }

    pub fn ack_message(&mut self, message_id: u64) {
        if self
            .by_id
            .get(&message_id)
            .map_or(true, |message| message.read)
        {
            return;
        }
        let advances_unread =
            self.first_unread().map(|message| message.message_id) == Some(message_id);
        self.reset_resize_origins();
        if let Some(message) = self.by_id.get_mut(&message_id) {
            message.read = true;
        }
        for message in self.messages.iter_mut() {
            if message.message_id == message_id {
                message.read = true;
                break;
            }
        }

        if advances_unread {
            self.align_main_to_unread(MainViewportMotion::Advance);
        }
    }

    pub fn ack_user_messages(&mut self, uid: &str) {
        self.reset_resize_origins();
        let advances_unread = self.first_unread().map(|message| message.uid.as_str()) == Some(uid);
        for message in self.by_id.values_mut() {
            if message.uid == uid {
                message.read = true;
            }
        }

        for message in self.messages.iter_mut() {
            if message.uid == uid {
                message.read = true;
            }
        }

        if advances_unread {
            self.align_main_to_unread(MainViewportMotion::Advance);
        }
    }

    pub fn clear_read_messages(&mut self) -> usize {
        let mut removed_count = 0;
        for index in (0..self.messages.len()).rev() {
            if !self.messages[index].read {
                continue;
            }
            let removed = self.messages.remove(index).expect("existing message index");
            self.by_id.remove(&removed.message_id);
            self.remove_message_from_user_index(&removed);
            if index < self.main_start_index {
                self.main_start_index -= 1;
            }
            removed_count += 1;
        }
        if removed_count == 0 {
            return 0;
        }
        self.reset_resize_origins();

        // Keep the first surviving row at the top, including short trailing pages.
        self.main_start_index = self
            .main_start_index
            .min(self.messages.len().saturating_sub(1));
        self.main_top_aligned = !self.messages.is_empty();
        self.main_viewport_revision += 1;
        self.main_viewport_motion = None;
        if let Some(anchor_id) = self.anchor_message_id {
            if !self.by_id.contains_key(&anchor_id) {
                // Explicit cleanup can remove the anchor; the replacement may
                // need to be restored from main history into the smaller UID index.
                let remaining = self
                    .messages
                    .iter()
                    .filter(|message| Some(&message.uid) == self.selected_uid.as_ref());
                let next = remaining
                    .clone()
                    .find(|message| message.message_id > anchor_id)
                    .or_else(|| remaining.last())
                    .map(|message| message.message_id);
                if let Some(message_id) = next {
                    self.select_user_anchor(message_id);
                } else {
                    self.reset_person_selection();
                }
            }
        }
        removed_count
    }

    pub fn clear_all_messages(&mut self) -> usize {
        self.reset_resize_origins();
        let removed_count = self.messages.len();
        self.messages.clear();
        self.by_id.clear();
        self.ids_by_uid.clear();
        self.main_start_index = 0;
        self.main_top_aligned = false;
        self.main_viewport_revision += 1;
        self.main_viewport_motion = None;
        self.reset_person_selection();
        // Preserve the connection and next ID so stale clicks cannot read new rows.
        removed_count
    }

    pub fn select_user_anchor(&mut self, message_id: u64) {
        let Some(message) = self.by_id.get(&message_id) else {
            return;
        };
        let uid = message.uid.clone();
        self.selected_uid = Some(uid.clone());
        self.anchor_message_id = Some(message_id);
        self.hover_frozen = false;
        self.person_manual_viewport = false;
        self.person_resize_origin = None;
        // Main history can still contain messages evicted from the smaller UID index.
        let user_ids = self.ids_by_uid.entry(uid.clone()).or_default();
        if !user_ids.contains(&message_id) {
            let index = user_ids
                .iter()
                .position(|id| *id > message_id)
                .unwrap_or(user_ids.len());
            user_ids.insert(index, message_id);
        }
        self.person_start_index = self.compute_anchored_person_start();
        self.trim_user_capacity(&uid, &self.protected_person_ids());
        self.person_start_index = self.compute_anchored_person_start();
    }

    pub fn set_person_panel_hover(&mut self, value: bool) {
        self.hover_frozen = value;
    }

    pub fn scroll_main_viewport(&mut self, delta: isize) {
        if delta == 0 {
            return;
        }
        self.main_resize_origin = None;
        let normal_max = max_viewport_start(self.messages.len(), self.main_viewport_size);
        // Keep wheel steps continuous when leaving a short, top-aligned tail.
        let max_start = if self.main_top_aligned {
            normal_max.max(self.main_start_index)
        } else {
            normal_max
        };
        self.main_start_index = if delta >= 0 {
            self.main_start_index.saturating_add(delta as usize)
        } else {
            self.main_start_index.saturating_sub(delta.unsigned_abs())
        }
        .min(max_start);
        self.main_top_aligned = self.main_start_index > normal_max;
        self.main_viewport_revision += 1;
        self.main_viewport_motion = None;
    }

    pub fn jump_main_viewport_to_unread(&mut self) {
        self.align_main_to_unread(MainViewportMotion::Locate);
    }

    pub fn scroll_person_viewport(&mut self, delta: isize) {
        let user_count = self.selected_user_ids().len();
        if user_count == 0 {
            return;
        }
        self.person_manual_viewport = true;
        self.person_resize_origin = None;
        self.person_start_index = scroll_viewport_start(
            self.person_start_index,
            delta,
            user_count,
            self.person_viewport_size,
        );
    }

    pub fn set_person_history_count(&mut self, value: usize) {
        self.person_resize_origin = None;
        self.person_history_count = value.min(3);
        if !self.person_manual_viewport {
            self.person_start_index = self.compute_anchored_person_start();
        }
    }

    pub fn set_viewport_sizes(
        &mut self,
        main_viewport_size: Option<usize>,
        person_viewport_size: Option<usize>,
    ) {
        if let Some(value) = main_viewport_size {
            if clamp_viewport_size(value) != self.main_viewport_size {
                let origin = self.main_resize_origin.unwrap_or(ViewportResizeOrigin {
                    start_index: self.main_start_index,
                    pinned_to_bottom: self.is_main_viewport_at_bottom(),
                });
                self.main_resize_origin = Some(origin);
                self.main_viewport_size = clamp_viewport_size(value);
                if origin.pinned_to_bottom {
                    self.pin_main_viewport_to_bottom();
                } else {
                    self.main_start_index = origin.start_index;
                    self.clamp_main_viewport_start();
                }
            }
        }

        if let Some(value) = person_viewport_size {
            if clamp_viewport_size(value) == self.person_viewport_size {
                return;
            }
            let user_count = self.selected_user_ids().len();
            let origin = self.person_resize_origin.unwrap_or(ViewportResizeOrigin {
                start_index: self.person_start_index,
                pinned_to_bottom: user_count > 0
                    && self.person_start_index
                        >= max_viewport_start(user_count, self.person_viewport_size),
            });
            self.person_resize_origin = Some(origin);
            self.person_viewport_size = clamp_viewport_size(value);
            if self.person_manual_viewport {
                // Keep the original alignment across probes, even if a candidate
                // temporarily reaches the tail or prepends older history.
                self.person_start_index = if origin.pinned_to_bottom {
                    max_viewport_start(user_count, self.person_viewport_size)
                } else {
                    clamp_viewport_start(origin.start_index, user_count, self.person_viewport_size)
                };
            } else {
                self.person_start_index = self.compute_anchored_person_start();
            }
        }
    }

    pub fn set_connection(&mut self, status: impl Into<String>, connected: bool) {
        self.connection_status = status.into();
        self.connected = connected;
    }

    pub fn snapshot(&self) -> AppSnapshot {
        AppSnapshot {
            connected: self.connected,
            connection_status: self.connection_status.clone(),
            main_visible: self.main_visible(),
            first_unread_message_id: self.first_unread().map(|message| message.message_id),
            main_hidden_newer_count: self.main_hidden_newer_count(),
            main_cache_near_full: self.messages.iter().filter(|message| !message.read).count()
                >= self.main_capacity - self.main_capacity / 10,
            main_viewport_revision: self.main_viewport_revision,
            main_viewport_motion: self.main_viewport_motion,
            person_panel: self.person_panel(),
        }
    }

    fn main_visible(&self) -> Vec<DanmuMessage> {
        self.messages
            .iter()
            .skip(self.main_start_index)
            .take(self.main_viewport_size)
            .cloned()
            .collect()
    }

    fn person_panel(&self) -> PersonPanelSnapshot {
        let user_ids = self.selected_user_ids();
        let selected_message = self.selected_latest_message();
        let visible_messages = user_ids
            .iter()
            .skip(self.person_start_index)
            .take(self.person_viewport_size)
            .filter_map(|id| self.by_id.get(id))
            .cloned()
            .collect::<Vec<_>>();

        PersonPanelSnapshot {
            selected_uid: self.selected_uid.clone(),
            selected_nickname: selected_message.map(|message| message.nickname.clone()),
            selected_guard_type: selected_message.map(|message| message.guard_type),
            anchor_message_id: self.anchor_message_id,
            hover_frozen: self.hover_frozen,
            visible_messages,
            hidden_newer_count: user_ids
                .len()
                .saturating_sub(self.person_start_index + self.person_viewport_size),
        }
    }

    fn reset_resize_origins(&mut self) {
        self.main_resize_origin = None;
        self.person_resize_origin = None;
    }

    fn reset_person_selection(&mut self) {
        self.selected_uid = None;
        self.anchor_message_id = None;
        self.person_start_index = 0;
        self.person_manual_viewport = false;
        self.person_resize_origin = None;
        self.hover_frozen = false;
    }

    fn trim_main_capacity(&mut self, protected_person_ids: &HashSet<u64>) {
        if self.messages.len() < self.main_capacity || self.messages.len() <= 1 {
            return;
        }
        let target_size = self
            .main_capacity
            .saturating_sub(self.main_capacity.div_ceil(10))
            .max(1);
        let latest_id = self.messages.back().map(|message| message.message_id);
        // Preserve the anchor, prefer offscreen rows, then oldest read rows before unread.
        let mut candidates = self
            .messages
            .iter()
            .filter(|message| Some(message.message_id) != self.anchor_message_id)
            .collect::<Vec<_>>();
        candidates.sort_by_key(|message| {
            (
                protected_person_ids.contains(&message.message_id)
                    || Some(message.message_id) == latest_id,
                !message.read,
                message.message_id,
            )
        });
        let removed_ids = candidates
            .into_iter()
            .take(self.messages.len() - target_size)
            .map(|message| message.message_id)
            .collect::<HashSet<_>>();
        for index in (0..self.messages.len()).rev() {
            if removed_ids.contains(&self.messages[index].message_id) {
                let removed = self.messages.remove(index).expect("existing message index");
                self.by_id.remove(&removed.message_id);
                self.remove_message_from_user_index(&removed);
                if index < self.main_start_index {
                    self.main_start_index -= 1;
                }
            }
        }
    }

    fn remove_message_from_user_index(&mut self, message: &DanmuMessage) {
        let is_selected_uid = self.selected_uid.as_deref() == Some(message.uid.as_str());
        let Some(user_ids) = self.ids_by_uid.get_mut(&message.uid) else {
            return;
        };
        let Some(remove_index) = user_ids.iter().position(|id| *id == message.message_id) else {
            return;
        };

        user_ids.remove(remove_index);
        if is_selected_uid && remove_index < self.person_start_index {
            self.person_start_index = self.person_start_index.saturating_sub(1);
        }
        if is_selected_uid {
            self.person_start_index = self
                .person_start_index
                .min(user_ids.len().saturating_sub(1));
        }
        if user_ids.is_empty() {
            self.ids_by_uid.remove(&message.uid);
        }
    }

    fn trim_user_capacity(&mut self, uid: &str, protected_person_ids: &HashSet<u64>) {
        let preserved_anchor_id = if self.selected_uid.as_deref() == Some(uid) {
            self.anchor_message_id
        } else {
            None
        };
        let Some(user_ids) = self.ids_by_uid.get_mut(uid) else {
            return;
        };
        while user_ids.len() > self.per_user_capacity {
            let remove_index = preserved_anchor_id
                .and_then(|anchor_id| {
                    // Keep the newest arrival too; only tiny, entirely visible caches
                    // need to sacrifice a visible non-anchor row to stay bounded.
                    user_ids
                        .iter()
                        .take(user_ids.len() - 1)
                        .position(|id| !protected_person_ids.contains(id))
                        .or_else(|| user_ids.iter().position(|id| *id != anchor_id))
                })
                .unwrap_or(0);

            user_ids.remove(remove_index);
            if self.selected_uid.as_deref() == Some(uid) {
                if remove_index < self.person_start_index {
                    self.person_start_index -= 1;
                }
                self.person_start_index = self
                    .person_start_index
                    .min(user_ids.len().saturating_sub(1));
            }
        }
    }

    fn protected_person_ids(&self) -> HashSet<u64> {
        let mut ids = self
            .selected_user_ids()
            .into_iter()
            .skip(self.person_start_index)
            .take(self.person_viewport_size)
            .collect::<HashSet<_>>();
        if let Some(anchor_id) = self.anchor_message_id {
            ids.insert(anchor_id);
        }
        ids
    }

    fn is_main_viewport_at_bottom(&self) -> bool {
        !self.main_top_aligned
            && self.messages.len() > self.main_viewport_size
            && self.main_start_index
                >= max_viewport_start(self.messages.len(), self.main_viewport_size)
    }

    fn pin_main_viewport_to_bottom(&mut self) {
        self.main_start_index = max_viewport_start(self.messages.len(), self.main_viewport_size);
    }

    fn clamp_main_viewport_start(&mut self) {
        let max_start = if self.main_top_aligned {
            self.messages.len().saturating_sub(1)
        } else {
            max_viewport_start(self.messages.len(), self.main_viewport_size)
        };
        self.main_start_index = self.main_start_index.min(max_start);
    }

    fn first_unread(&self) -> Option<&DanmuMessage> {
        self.messages.iter().find(|message| !message.read)
    }

    fn align_main_to_unread(&mut self, motion: MainViewportMotion) {
        self.main_resize_origin = None;
        let index = self.messages.iter().position(|message| !message.read);
        let previous_start = self.main_start_index;
        self.main_top_aligned = index.is_some();
        self.main_start_index = index
            .unwrap_or_else(|| max_viewport_start(self.messages.len(), self.main_viewport_size));
        self.main_viewport_revision += 1;
        self.main_viewport_motion = if index.is_some() && previous_start != self.main_start_index {
            Some(motion)
        } else {
            None
        };
    }

    fn main_hidden_newer_count(&self) -> usize {
        self.messages
            .len()
            .saturating_sub(self.main_start_index + self.main_viewport_size)
    }

    fn selected_user_ids(&self) -> Vec<u64> {
        self.selected_uid
            .as_ref()
            .and_then(|uid| self.ids_by_uid.get(uid))
            .map(|ids| ids.iter().copied().collect())
            .unwrap_or_default()
    }

    fn selected_latest_message(&self) -> Option<&DanmuMessage> {
        let selected_uid = self.selected_uid.as_ref()?;
        let user_ids = self.ids_by_uid.get(selected_uid)?;
        user_ids.iter().rev().find_map(|id| self.by_id.get(id))
    }

    fn compute_anchored_person_start(&self) -> usize {
        let user_ids = self.selected_user_ids();
        let Some(anchor_id) = self.anchor_message_id else {
            return 0;
        };
        if user_ids.is_empty() {
            return 0;
        }

        let Some(anchor_index) = user_ids.iter().position(|id| *id == anchor_id) else {
            return user_ids.len().saturating_sub(self.person_viewport_size);
        };

        let latest_start = user_ids.len().saturating_sub(self.person_viewport_size);
        let history_count = self
            .person_history_count
            .min(self.person_viewport_size.saturating_sub(1));
        anchor_index.saturating_sub(history_count).min(latest_start)
    }
}

fn scroll_viewport_start(
    start_index: usize,
    delta: isize,
    item_count: usize,
    viewport_size: usize,
) -> usize {
    let max_start = max_viewport_start(item_count, viewport_size);
    let next = if delta >= 0 {
        start_index.saturating_add(delta as usize)
    } else {
        start_index.saturating_sub(delta.unsigned_abs())
    };
    next.min(max_start)
}

fn clamp_viewport_start(start_index: usize, item_count: usize, viewport_size: usize) -> usize {
    start_index.min(max_viewport_start(item_count, viewport_size))
}

fn max_viewport_start(item_count: usize, viewport_size: usize) -> usize {
    item_count.saturating_sub(viewport_size)
}

fn clamp_viewport_size(value: usize) -> usize {
    value.clamp(1, 100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(content: &str, uid: u64, timestamp_ms: i64) -> IncomingDanmuRaw {
        IncomingDanmuRaw {
            content: content.to_string(),
            uid: json!(uid),
            nickname: "观众".to_string(),
            user_level: 12,
            fan_level: 8,
            guard_type: 0,
            message_type: crate::models::MessageType::Danmu,
            super_chat: None,
            timestamp_ms: Some(timestamp_ms),
            timestamp: None,
        }
    }

    #[test]
    fn main_viewport_does_not_auto_scroll_on_overflow() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        let snapshot = store.snapshot();
        let visible = snapshot
            .main_visible
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>();
        assert_eq!(visible, ["A", "B", "C", "D", "E"]);
    }

    #[test]
    fn main_viewport_advances_only_after_top_messages_are_read() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        store.ack_message(2);
        assert_eq!(store.snapshot().main_visible[0].content, "A");
        store.ack_message(1);
        let snapshot = store.snapshot();
        let visible = snapshot
            .main_visible
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>();
        assert_eq!(visible, ["C", "D", "E", "F", "G"]);
    }

    #[test]
    fn ack_user_messages_marks_all_cached_messages_from_that_uid() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        store.ingest(raw("A", 1, 1)).unwrap();
        store.ingest(raw("B", 2, 2)).unwrap();
        store.ingest(raw("C", 1, 3)).unwrap();
        store.ingest(raw("D", 1, 4)).unwrap();
        store.ingest(raw("E", 2, 5)).unwrap();

        store.ack_user_messages("1");

        assert_eq!(
            store
                .snapshot()
                .main_visible
                .iter()
                .map(|message| format!("{}:{}", message.content, message.read))
                .collect::<Vec<_>>(),
            ["B:false", "C:true", "D:true", "E:false"]
        );
    }

    #[test]
    fn main_viewport_puts_next_unread_first_near_the_end() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        store.ack_message(1);
        store.ack_message(2);
        store.ack_message(3);

        assert_eq!(main_contents(&store), ["D", "E", "F", "G"]);
    }

    #[test]
    fn main_viewport_scrolls_history_and_newer_without_auto_following() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        store.scroll_main_viewport(2);
        assert_eq!(main_contents(&store), ["C", "D", "E", "F", "G"]);

        store.scroll_main_viewport(-1);
        assert_eq!(main_contents(&store), ["B", "C", "D", "E", "F"]);

        store.ingest(raw("I", 1, 1)).unwrap();
        assert_eq!(main_contents(&store), ["B", "C", "D", "E", "F"]);

        store.scroll_main_viewport(99);
        assert_eq!(main_contents(&store), ["E", "F", "G", "H", "I"]);
    }

    #[test]
    fn main_viewport_counts_hidden_newer_messages_as_it_moves() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        assert_eq!(store.snapshot().main_hidden_newer_count, 2);

        store.scroll_main_viewport(1);
        assert_eq!(store.snapshot().main_hidden_newer_count, 1);

        store.scroll_main_viewport(99);
        assert_eq!(store.snapshot().main_hidden_newer_count, 0);
    }

    #[test]
    fn main_viewport_jumps_to_first_unread_message_from_current_top() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        store.ack_message(1);
        store.ack_message(2);
        store.ack_message(3);
        store.scroll_main_viewport(-1);
        assert_eq!(
            store
                .snapshot()
                .main_visible
                .iter()
                .map(|message| format!("{}:{}", message.content, message.read))
                .collect::<Vec<_>>(),
            ["C:true", "D:false", "E:false", "F:false", "G:false"]
        );

        store.jump_main_viewport_to_unread();

        assert_eq!(main_contents(&store), ["D", "E", "F", "G", "H"]);
    }

    #[test]
    fn main_viewport_puts_unread_first_near_the_end() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        for message_id in 1..=7 {
            store.ack_message(message_id);
        }
        store.scroll_main_viewport(-5);
        assert_eq!(
            store
                .snapshot()
                .main_visible
                .iter()
                .map(|message| format!("{}:{}", message.content, message.read))
                .collect::<Vec<_>>(),
            ["C:true", "D:true", "E:true", "F:true", "G:true"]
        );

        store.jump_main_viewport_to_unread();

        assert_eq!(main_contents(&store), ["H", "I", "J"]);
    }

    #[test]
    fn main_viewport_jumps_to_newest_page_when_no_unread_remains() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        for message_id in 1..=8 {
            store.ack_message(message_id);
        }
        store.scroll_main_viewport(-2);

        store.jump_main_viewport_to_unread();

        assert_eq!(main_contents(&store), ["D", "E", "F", "G", "H"]);
    }

    #[test]
    fn main_viewport_keeps_bottom_pinned_when_new_message_arrives_at_bottom() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        store.scroll_main_viewport(99);
        assert_eq!(main_contents(&store), ["C", "D", "E", "F", "G"]);

        store.ingest(raw("H", 1, 1)).unwrap();
        assert_eq!(main_contents(&store), ["D", "E", "F", "G", "H"]);
    }

    #[test]
    fn main_viewport_keeps_bottom_pinned_when_viewport_shrinks_at_bottom() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }

        store.scroll_main_viewport(99);
        assert_eq!(main_contents(&store), ["F", "G", "H", "I", "J"]);

        store.set_viewport_sizes(Some(3), None);
        assert_eq!(main_contents(&store), ["H", "I", "J"]);
    }

    #[test]
    fn snapshot_tracks_global_unread_across_scrolling_reads_and_trimming() {
        let mut store = MessageStore::new(4, 50);
        store.main_viewport_size = 2;
        let empty = serde_json::to_value(store.snapshot()).unwrap();
        assert_eq!(
            empty.get("firstUnreadMessageId"),
            Some(&serde_json::Value::Null)
        );
        store.ingest(raw("A", 1, 1)).unwrap();
        store.ingest(raw("B", 2, 2)).unwrap();
        store.ingest(raw("C", 1, 3)).unwrap();
        store.scroll_main_viewport(1);
        assert_eq!(main_contents(&store), ["B", "C"]);
        assert_eq!(store.snapshot().first_unread_message_id, Some(1));
        let snapshot = serde_json::to_value(store.snapshot()).unwrap();
        assert_eq!(snapshot["firstUnreadMessageId"], 1);
        store.ack_main_message(2);
        assert_eq!(store.snapshot().first_unread_message_id, Some(1));
        store.ack_user_messages("1");
        assert_eq!(store.snapshot().first_unread_message_id, Some(2));
        store.ingest(raw("D", 3, 4)).unwrap();
        store.ingest(raw("E", 3, 5)).unwrap();
        assert_eq!(store.snapshot().first_unread_message_id, Some(2));
        store.ack_main_message(2);
        assert_eq!(store.snapshot().first_unread_message_id, Some(4));
        store.ack_message(4);
        assert_eq!(store.snapshot().first_unread_message_id, Some(5));
        store.ack_main_message(5);
        assert_eq!(store.snapshot().first_unread_message_id, None);
        store.ingest(raw("F", 3, 6)).unwrap();
        assert_eq!(store.snapshot().first_unread_message_id, Some(6));
    }

    #[test]
    fn main_clicks_require_global_first_unread_even_outside_viewport() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 3;
        for content in ["A", "B", "C", "D", "E", "F", "G"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        store.scroll_main_viewport(3);
        store.select_user_anchor(4);
        store.ack_main_message(4);
        assert!(!store.snapshot().main_visible[0].read);
        assert_eq!(store.snapshot().person_panel.anchor_message_id, Some(4));
        store.jump_main_viewport_to_unread();
        assert_eq!(store.snapshot().main_visible[0].message_id, 1);
        store.ack_main_message(3);
        store.ack_main_message(1);
        assert_eq!(main_contents(&store), ["B", "C", "D"]);
        assert!(store
            .snapshot()
            .main_visible
            .iter()
            .all(|message| !message.read));
    }

    #[test]
    fn person_reads_can_skip_ahead_and_main_advance_skips_read_messages() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        store.ack_message(2);
        store.ack_message(3);
        assert_eq!(store.main_viewport_revision, 0);
        assert_eq!(store.snapshot().main_visible[0].message_id, 1);
        store.ack_main_message(1);
        assert_eq!(main_contents(&store), ["D", "E"]);
        assert_eq!(
            store.main_viewport_motion,
            Some(MainViewportMotion::Advance)
        );
    }

    #[test]
    fn unread_top_survives_ingest_resize_and_cache_trimming() {
        let mut store = MessageStore::new(6, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        for id in 1..=5 {
            store.ack_main_message(id);
        }
        let revision = store.main_viewport_revision;
        store.set_viewport_sizes(Some(3), None);
        store.ingest(raw("G", 1, 1)).unwrap();
        store.set_viewport_sizes(Some(8), None);
        assert_eq!(main_contents(&store), ["F", "G"]);
        assert_eq!(store.main_viewport_revision, revision);
        assert_eq!(store.snapshot().main_hidden_newer_count, 0);
    }

    #[test]
    fn locate_finds_global_unread_in_both_directions_without_reading() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 3;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        store.ack_main_message(1);
        store.scroll_main_viewport(99);
        store.jump_main_viewport_to_unread();
        assert_eq!(store.snapshot().main_visible[0].message_id, 2);
        assert!(!store.snapshot().main_visible[0].read);
        assert_eq!(store.main_viewport_motion, Some(MainViewportMotion::Locate));
        store.scroll_main_viewport(-1);
        store.jump_main_viewport_to_unread();
        assert_eq!(store.snapshot().main_visible[0].message_id, 2);
        assert!(!store.snapshot().main_visible[0].read);
    }

    #[test]
    fn wheel_steps_stay_continuous_from_a_short_top_aligned_tail() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 5;
        for content in ["A", "B", "C", "D", "E", "F", "G", "H"] {
            store.ingest(raw(content, 1, 1)).unwrap();
        }
        for id in 1..=6 {
            store.ack_main_message(id);
        }
        store.scroll_main_viewport(1);
        assert_eq!(store.snapshot().main_visible[0].message_id, 7);
        store.scroll_main_viewport(-1);
        assert_eq!(store.snapshot().main_visible[0].message_id, 6);
        store.scroll_main_viewport(-1);
        assert_eq!(store.snapshot().main_visible[0].message_id, 5);
        assert_eq!(store.main_viewport_motion, None);
        store.jump_main_viewport_to_unread();
        assert_eq!(store.snapshot().main_visible[0].message_id, 7);
    }

    #[test]
    fn stale_clicks_are_idempotent_and_last_unread_does_not_animate() {
        let mut store = MessageStore::new(1000, 50);
        store.jump_main_viewport_to_unread();
        assert_eq!(store.main_viewport_motion, None);
        store.ingest(raw("A", 1, 1)).unwrap();
        store.ingest(raw("B", 1, 1)).unwrap();
        store.ack_main_message(1);
        let revision = store.main_viewport_revision;
        store.ack_main_message(1);
        store.ack_message(1);
        store.ack_message(999);
        assert_eq!(store.main_viewport_revision, revision);
        store.ack_main_message(2);
        assert!(store
            .snapshot()
            .main_visible
            .iter()
            .all(|message| message.read));
        assert_eq!(store.main_viewport_motion, None);
    }

    #[test]
    fn person_header_keeps_latest_nickname_and_guard_identity_while_browsing_history() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 2;
        assert_eq!(store.snapshot().person_panel.selected_guard_type, None);
        for index in 1..=5 {
            let mut message = raw("历史消息", 42, index);
            message.nickname = "旧昵称".to_string();
            message.guard_type = 3;
            store.ingest(message).unwrap();
        }
        store.select_user_anchor(1);
        let mut latest = raw("新消息", 42, 6);
        latest.nickname = "新昵称".to_string();
        latest.guard_type = 2;
        store.ingest(latest).unwrap();

        assert!(!store
            .snapshot()
            .person_panel
            .visible_messages
            .iter()
            .any(|message| message.message_id == 6));
        for delta in [0, 99, -99] {
            store.scroll_person_viewport(delta);
            let panel = store.snapshot().person_panel;
            assert_eq!(panel.selected_nickname.as_deref(), Some("新昵称"));
            assert_eq!(panel.selected_guard_type, Some(2));
        }

        let mut other = raw("其他用户", 99, 7);
        other.nickname = "另一位观众".to_string();
        other.guard_type = 0;
        store.ingest(other).unwrap();
        store.select_user_anchor(7);
        let panel = store.snapshot().person_panel;
        assert_eq!(panel.selected_nickname.as_deref(), Some("另一位观众"));
        assert_eq!(panel.selected_guard_type, Some(0));
    }

    #[test]
    fn person_anchor_stops_at_second_row_and_counts_hidden_newer() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=8 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }
        store.select_user_anchor(3);
        let panel = store.snapshot().person_panel;
        assert_eq!(panel.selected_nickname.as_deref(), Some("观众"));
        let visible = panel
            .visible_messages
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>();
        assert_eq!(visible, ["M2", "M3", "M4", "M5", "M6"]);
        assert_eq!(panel.hidden_newer_count, 2);
    }

    #[test]
    fn person_anchor_can_start_on_first_row_when_history_count_is_zero() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=8 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.set_person_history_count(0);
        store.select_user_anchor(3);

        let panel = store.snapshot().person_panel;
        let anchor_row = panel
            .visible_messages
            .iter()
            .position(|message| Some(message.message_id) == panel.anchor_message_id);

        assert_eq!(person_contents(&store), ["M3", "M4", "M5", "M6", "M7"]);
        assert_eq!(anchor_row, Some(0));
        assert_eq!(panel.hidden_newer_count, 1);
    }

    #[test]
    fn person_anchor_shows_three_history_messages_when_configured() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=8 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.set_person_history_count(3);
        store.select_user_anchor(5);

        let panel = store.snapshot().person_panel;
        let anchor_row = panel
            .visible_messages
            .iter()
            .position(|message| Some(message.message_id) == panel.anchor_message_id);

        assert_eq!(person_contents(&store), ["M2", "M3", "M4", "M5", "M6"]);
        assert_eq!(anchor_row, Some(3));
        assert_eq!(panel.hidden_newer_count, 2);
    }

    #[test]
    fn person_anchor_keeps_viewport_full_near_bottom_when_history_count_is_high() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=7 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.set_person_history_count(3);
        store.select_user_anchor(7);

        let panel = store.snapshot().person_panel;
        let anchor_row = panel
            .visible_messages
            .iter()
            .position(|message| Some(message.message_id) == panel.anchor_message_id);

        assert_eq!(person_contents(&store), ["M3", "M4", "M5", "M6", "M7"]);
        assert_eq!(anchor_row, Some(4));
        assert_eq!(panel.hidden_newer_count, 0);
    }

    #[test]
    fn person_history_count_change_does_not_override_manual_person_viewport() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=8 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.select_user_anchor(5);
        store.scroll_person_viewport(-1);
        assert_eq!(person_contents(&store), ["M3", "M4", "M5", "M6", "M7"]);

        store.set_person_history_count(3);

        assert_eq!(person_contents(&store), ["M3", "M4", "M5", "M6", "M7"]);
    }

    #[test]
    fn person_anchor_stays_on_its_current_row_when_new_messages_arrive() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=5 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.select_user_anchor(3);
        store.ingest(raw("M6", 42, 6)).unwrap();
        assert_eq!(person_contents(&store), ["M1", "M2", "M3", "M4", "M5"]);

        store.ingest(raw("M7", 42, 7)).unwrap();
        let panel = store.snapshot().person_panel;
        let visible = panel
            .visible_messages
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>();
        let anchor_row = panel
            .visible_messages
            .iter()
            .position(|message| Some(message.message_id) == panel.anchor_message_id);

        assert_eq!(visible, ["M1", "M2", "M3", "M4", "M5"]);
        assert_eq!(anchor_row, Some(2));
        assert_eq!(panel.hidden_newer_count, 2);
    }

    #[test]
    fn person_anchor_is_preserved_when_trimming_per_user_message_cache() {
        let mut store = MessageStore::new(1000, 5);
        store.person_viewport_size = 5;
        for i in 1..=5 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.select_user_anchor(3);
        for i in 6..=8 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        let panel = store.snapshot().person_panel;
        let visible = panel
            .visible_messages
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>();
        let anchor_visible = panel
            .visible_messages
            .iter()
            .any(|message| Some(message.message_id) == panel.anchor_message_id);

        assert!(anchor_visible);
        assert_eq!(visible, ["M3", "M5", "M6", "M7", "M8"]);
    }

    #[test]
    fn person_anchor_is_preserved_when_trimming_main_message_cache() {
        let mut store = MessageStore::new(10, 20);
        store.main_viewport_size = 5;
        store.person_viewport_size = 3;
        for i in 1..=5 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.select_user_anchor(3);
        for i in 6..=12 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        let panel = store.snapshot().person_panel;
        let visible = panel
            .visible_messages
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>();
        let anchor_visible = panel
            .visible_messages
            .iter()
            .any(|message| Some(message.message_id) == panel.anchor_message_id);

        assert!(anchor_visible);
        assert_eq!(visible, ["M2", "M3", "M4"]);
        assert_eq!(panel.hidden_newer_count, 6);
    }

    #[test]
    fn person_viewport_scrolls_history_and_newer() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=9 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.select_user_anchor(4);
        assert_eq!(person_contents(&store), ["M3", "M4", "M5", "M6", "M7"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 2);

        store.scroll_person_viewport(-2);
        assert_eq!(person_contents(&store), ["M1", "M2", "M3", "M4", "M5"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 4);

        store.set_person_panel_hover(true);
        store.scroll_person_viewport(99);
        assert_eq!(person_contents(&store), ["M5", "M6", "M7", "M8", "M9"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 0);

        store.set_person_panel_hover(false);
        store.ingest(raw("M10", 42, 10)).unwrap();
        assert_eq!(person_contents(&store), ["M5", "M6", "M7", "M8", "M9"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 1);
    }

    #[test]
    fn resize_alignment_restores_original_first_row_after_capacity_probe_reaches_tail() {
        for capacity in [3, 4, 10] {
            let mut store = MessageStore::new(1000, 50);
            store.main_viewport_size = 2;
            store.person_viewport_size = 2;
            for i in 1..=10 {
                store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
            }
            store.scroll_main_viewport(7);
            store.select_user_anchor(10);
            store.scroll_person_viewport(-1);
            assert_eq!(main_contents(&store), ["M8", "M9"]);
            assert_eq!(person_contents(&store), ["M8", "M9"]);

            store.set_viewport_sizes(Some(capacity), Some(capacity));
            let expected = (11 - capacity..=10)
                .map(|i| format!("M{i}"))
                .collect::<Vec<_>>();
            assert_eq!(main_contents(&store), expected);
            assert_eq!(person_contents(&store), expected);
            store.set_viewport_sizes(Some(2), Some(2));
            assert_eq!(main_contents(&store), ["M8", "M9"]);
            assert_eq!(person_contents(&store), ["M8", "M9"]);
            assert_eq!(store.snapshot().main_hidden_newer_count, 1);
            assert_eq!(store.snapshot().person_panel.hidden_newer_count, 1);
        }
    }

    #[test]
    fn resize_alignment_does_not_follow_new_messages_when_pending_growth_probe_reaches_tail() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 2;
        store.person_viewport_size = 2;
        for i in 1..=10 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }
        store.scroll_main_viewport(7);
        store.select_user_anchor(10);
        store.scroll_person_viewport(-1);
        store.set_viewport_sizes(Some(3), Some(3));
        store.ingest(raw("M11", 42, 11)).unwrap();
        assert_eq!(main_contents(&store), ["M8", "M9", "M10"]);
        assert_eq!(person_contents(&store), ["M8", "M9", "M10"]);
        store.set_viewport_sizes(Some(2), Some(2));
        assert_eq!(main_contents(&store), ["M8", "M9"]);
        assert_eq!(person_contents(&store), ["M8", "M9"]);
    }

    #[test]
    fn resize_alignment_resets_after_manual_navigation_and_new_arrivals() {
        let mut store = MessageStore::new(1000, 50);
        store.main_viewport_size = 2;
        store.person_viewport_size = 2;
        for i in 1..=10 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }
        store.scroll_main_viewport(7);
        store.select_user_anchor(10);
        store.scroll_person_viewport(-1);
        store.set_viewport_sizes(Some(3), Some(3));
        store.set_viewport_sizes(Some(2), Some(2));
        store.scroll_main_viewport(1);
        store.scroll_person_viewport(1);
        store.set_viewport_sizes(Some(3), Some(3));
        store.set_viewport_sizes(Some(2), Some(2));
        assert_eq!(main_contents(&store), ["M9", "M10"]);
        assert_eq!(person_contents(&store), ["M9", "M10"]);

        store.ingest(raw("M11", 42, 11)).unwrap();
        store.set_viewport_sizes(Some(3), Some(3));
        store.set_viewport_sizes(Some(2), Some(2));
        assert_eq!(main_contents(&store), ["M10", "M11"]);
        assert_eq!(person_contents(&store), ["M9", "M10"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 1);
    }

    #[test]
    fn person_manual_viewport_restores_tail_after_rejected_growth_without_following_new_messages() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 2;
        for i in 1..=10 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }
        store.select_user_anchor(10);
        store.scroll_person_viewport(1);
        assert_eq!(person_contents(&store), ["M9", "M10"]);

        store.set_viewport_sizes(None, Some(3));
        assert_eq!(person_contents(&store), ["M8", "M9", "M10"]);
        store.set_viewport_sizes(None, Some(2));
        assert_eq!(person_contents(&store), ["M9", "M10"]);
        assert_eq!(store.snapshot().person_panel.anchor_message_id, Some(10));
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 0);

        store.ingest(raw("M11", 42, 11)).unwrap();
        assert_eq!(person_contents(&store), ["M9", "M10"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 1);
    }

    #[test]
    fn person_manual_viewport_keeps_first_history_row_during_capacity_changes_away_from_tail() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 2;
        for i in 1..=10 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }
        store.select_user_anchor(10);
        store.scroll_person_viewport(-5);
        assert_eq!(person_contents(&store), ["M4", "M5"]);

        store.set_viewport_sizes(None, Some(3));
        assert_eq!(person_contents(&store), ["M4", "M5", "M6"]);
        store.set_viewport_sizes(None, Some(2));
        assert_eq!(person_contents(&store), ["M4", "M5"]);
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 5);
    }

    #[test]
    fn person_viewport_size_updates_to_fill_taller_panel() {
        let mut store = MessageStore::new(1000, 50);
        store.person_viewport_size = 5;
        for i in 1..=9 {
            store.ingest(raw(&format!("M{i}"), 42, i)).unwrap();
        }

        store.select_user_anchor(4);
        assert_eq!(person_contents(&store), ["M3", "M4", "M5", "M6", "M7"]);

        store.set_viewport_sizes(None, Some(8));

        assert_eq!(
            person_contents(&store),
            ["M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"]
        );
        assert_eq!(store.snapshot().person_panel.hidden_newer_count, 0);
    }

    fn main_contents(store: &MessageStore) -> Vec<String> {
        store
            .snapshot()
            .main_visible
            .iter()
            .map(|message| message.content.clone())
            .collect()
    }

    fn person_contents(store: &MessageStore) -> Vec<String> {
        store
            .snapshot()
            .person_panel
            .visible_messages
            .iter()
            .map(|message| message.content.clone())
            .collect()
    }
}
