//! Which editor a file opens in, and whether it opens at all
//! (`modules/editors/editor-type.ts` over `utils/fs.ts`'s extension sets).

/// `EditorType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EditorType {
    Markdown,
    Image,
    /// The bundled release-notes tab.
    ReleaseNotes,
    /// Read-only code viewer.
    Code,
}

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"];

const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdown", "mkd", "txt", "text", "js", "jsx", "ts", "tsx", "json", "html", "css", "scss", "sass",
    "py", "rb", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php", "swift", "kt", "dart", "scala", "sh", "bash",
    "zsh", "yaml", "yml", "toml", "xml", "ini", "conf", "config", "rst", "adoc", "asciidoc", "org", "log", "csv", "tsv",
    "sql",
];

/// Extensions that open in the editable markdown editor; other text opens
/// read-only in the code viewer (the markdown codec would rewrite it).
const MARKDOWN_EDITABLE: &[&str] = &["md", "markdown", "mdown", "mkd", "txt", "text"];

/// `getFileExtension`: lowercase, "" with none. Diverges from TS in
/// reading the file name only (TS splits the whole path, so a dotted folder
/// name leaks into an extensionless file's "extension").
pub fn file_extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() > 1 { parts[parts.len() - 1].to_ascii_lowercase() } else { String::new() }
}

pub fn is_image_file(path: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&file_extension(path).as_str())
}

pub fn is_text_file(path: &str) -> bool {
    TEXT_EXTENSIONS.contains(&file_extension(path).as_str())
}

/// `getEditorType`.
pub fn editor_type(path: &str) -> EditorType {
    if is_image_file(path) {
        return EditorType::Image;
    }
    if MARKDOWN_EDITABLE.contains(&file_extension(path).as_str()) { EditorType::Markdown } else { EditorType::Code }
}

/// `canOpenFile`: images, known text, and extensionless files.
pub fn can_open_file(path: &str) -> bool {
    let ext = file_extension(path);
    ext.is_empty() || is_image_file(path) || is_text_file(path)
}
