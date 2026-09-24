use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowAction {
    Show,
    Hide,
}

impl WindowAction {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Show => "显示窗口",
            Self::Hide => "隐藏窗口",
        }
    }
}

fn window_action(visible: bool, minimized: bool, on_screen: bool) -> WindowAction {
    if visible && !minimized && on_screen {
        WindowAction::Hide
    } else {
        WindowAction::Show
    }
}

#[derive(Clone, Copy)]
struct ScreenRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl ScreenRect {
    fn intersects(self, other: Self) -> bool {
        self.width > 0
            && self.height > 0
            && other.width > 0
            && other.height > 0
            && i64::from(self.x) < i64::from(other.x) + i64::from(other.width)
            && i64::from(other.x) < i64::from(self.x) + i64::from(self.width)
            && i64::from(self.y) < i64::from(other.y) + i64::from(other.height)
            && i64::from(other.y) < i64::from(self.y) + i64::from(self.height)
    }

    fn centered_position(self, size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
        // Oversized windows keep their top-left controls reachable.
        PhysicalPosition::new(
            (i64::from(self.x) + i64::from(self.width.saturating_sub(size.width)) / 2) as i32,
            (i64::from(self.y) + i64::from(self.height.saturating_sub(size.height)) / 2) as i32,
        )
    }
}

fn window_is_on_screen(window: &WebviewWindow) -> tauri::Result<bool> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let rect = ScreenRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let monitors = window.available_monitors()?;
    // A temporarily unavailable monitor list is not evidence of an off-screen window.
    Ok(monitors.is_empty()
        || monitors.iter().any(|monitor| {
            let area = monitor.work_area();
            rect.intersects(ScreenRect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            })
        }))
}

pub(crate) fn current_window_action(window: &WebviewWindow) -> tauri::Result<WindowAction> {
    let visible = window.is_visible()?;
    let minimized = window.is_minimized()?;
    Ok(window_action(
        visible,
        minimized,
        !visible || minimized || window_is_on_screen(window)?,
    ))
}

pub(crate) fn recover_offscreen_window(window: &WebviewWindow) -> tauri::Result<()> {
    if window_is_on_screen(window)? {
        return Ok(());
    }
    let monitor = window
        .primary_monitor()?
        .or(window.available_monitors()?.into_iter().next());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        // Enter the target monitor before fitting: moving across DPI scales can resize the window.
        window.set_position(area.position)?;
        let size = window.inner_size()?;
        // A removed, larger monitor must not leave the recovered window oversized.
        window.set_size(PhysicalSize::new(
            size.width.min(area.size.width),
            size.height.min(area.size.height),
        ))?;
        let rect = ScreenRect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        };
        window.set_position(rect.centered_position(window.outer_size()?))?;
    }
    Ok(())
}

pub(crate) fn show_main_window(window: &WebviewWindow) -> tauri::Result<()> {
    // Restore first: minimized windows report a special off-screen rectangle on Windows.
    window.unminimize()?;
    recover_offscreen_window(window)?;
    window.show()?;
    window.set_focus()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_only_hides_a_visible_normal_onscreen_window() {
        for visible in [false, true] {
            for minimized in [false, true] {
                for on_screen in [false, true] {
                    assert_eq!(
                        window_action(visible, minimized, on_screen),
                        if visible && !minimized && on_screen {
                            WindowAction::Hide
                        } else {
                            WindowAction::Show
                        }
                    );
                }
            }
        }
        assert_eq!(WindowAction::Show.label(), "显示窗口");
        assert_eq!(WindowAction::Hide.label(), "隐藏窗口");
    }

    #[test]
    fn negative_monitor_coordinates_and_partial_visibility_are_valid() {
        let monitor = ScreenRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert!(monitor.intersects(ScreenRect {
            x: -1800,
            y: 100,
            width: 420,
            height: 520
        }));
        assert!(monitor.intersects(ScreenRect {
            x: -200,
            y: 100,
            width: 420,
            height: 520
        }));
        assert!(!monitor.intersects(ScreenRect {
            x: 0,
            y: 100,
            width: 420,
            height: 520
        }));
        assert!(!monitor.intersects(ScreenRect {
            x: -1800,
            y: 1040,
            width: 420,
            height: 520
        }));
    }

    #[test]
    fn intersection_rejects_empty_and_extreme_offscreen_rectangles() {
        let monitor = ScreenRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert!(!monitor.intersects(ScreenRect {
            x: i32::MAX,
            y: 0,
            width: 420,
            height: 520
        }));
        assert!(!monitor.intersects(ScreenRect {
            x: 10,
            y: 10,
            width: 0,
            height: 520
        }));
    }

    #[test]
    fn recovery_centers_in_work_area_and_keeps_oversized_controls_reachable() {
        let monitor = ScreenRect {
            x: -1920,
            y: 40,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            monitor.centered_position(PhysicalSize::new(420, 520)),
            PhysicalPosition::new(-1170, 300)
        );
        assert_eq!(
            monitor.centered_position(PhysicalSize::new(2560, 1440)),
            PhysicalPosition::new(-1920, 40)
        );
    }
}
