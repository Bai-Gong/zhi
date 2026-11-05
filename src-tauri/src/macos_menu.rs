//! macOS uses the system menu bar and native window controls.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem as Native, Submenu},
    App, Emitter,
};

pub fn install(app: &App) -> tauri::Result<()> {
    let application = Submenu::with_items(app, "百工·纸", true, &[
        &Native::about(app, Some("关于百工·纸"), None)?,
        &Native::separator(app)?,
        &Native::services(app, Some("服务"))?,
        &Native::separator(app)?,
        &Native::hide(app, Some("隐藏百工·纸"))?,
        &Native::hide_others(app, Some("隐藏其他应用"))?,
        &Native::show_all(app, Some("显示全部"))?,
        &Native::separator(app)?,
        &Native::quit(app, Some("退出百工·纸"))?,
    ])?;
    let file = Submenu::with_items(app, "文件", true, &[
        &MenuItem::with_id(app, "open", "打开 PDF…", true, Some("Cmd+O"))?,
        &Native::separator(app)?,
        &Native::close_window(app, Some("关闭窗口"))?,
    ])?;
    let edit = Submenu::with_items(app, "编辑", true, &[
        &Native::undo(app, Some("撤销"))?,
        &Native::redo(app, Some("重做"))?,
        &Native::separator(app)?,
        &Native::cut(app, Some("剪切"))?,
        &Native::copy(app, Some("复制"))?,
        &Native::paste(app, Some("粘贴"))?,
        &Native::select_all(app, Some("全选"))?,
    ])?;
    let tools = Submenu::new(app, "文档", true)?;
    for (id, label) in [
        ("merge", "合并 PDF…"), ("split", "拆分 PDF…"),
        ("pdf-to-word", "PDF 转 Word…"), ("word-to-pdf", "Word 转 PDF…"),
        ("pdf-to-images", "PDF 转图片…"), ("images-to-pdf", "图片转 PDF…"),
    ] {
        tools.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
    let view = Submenu::with_items(app, "显示", true, &[
        &MenuItem::with_id(app, "home", "全部工具", true, None::<&str>)?,
        &MenuItem::with_id(app, "viewer", "查看器", true, None::<&str>)?,
        &Native::separator(app)?,
        &MenuItem::with_id(app, "theme-light", "浅色外观", true, None::<&str>)?,
        &MenuItem::with_id(app, "theme-dark", "深色外观", true, None::<&str>)?,
        &MenuItem::with_id(app, "theme-system", "跟随系统外观", true, None::<&str>)?,
    ])?;
    let window = Submenu::with_items(app, "窗口", true, &[
        &Native::minimize(app, Some("最小化"))?,
        &Native::maximize(app, Some("缩放窗口"))?,
        &Native::fullscreen(app, Some("切换全屏"))?,
        &Native::separator(app)?,
        &Native::bring_all_to_front(app, Some("前置全部窗口"))?,
    ])?;
    app.set_menu(Menu::with_items(app, &[&application, &file, &edit, &tools, &view, &window])?)?;
    app.on_menu_event(|app, event| {
        if let Err(error) = app.emit_to("main", "zhi:native-menu", event.id().as_ref()) {
            eprintln!("无法发送菜单操作: {error}");
        }
    });
    Ok(())
}
