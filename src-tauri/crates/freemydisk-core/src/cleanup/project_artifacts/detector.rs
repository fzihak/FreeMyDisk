use super::schema::ProjectRule;
use std::path::Path;
use std::sync::OnceLock;

static BUILTIN_RULES: &[&str] = &[
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/angular.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/autoconf.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/bazel.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/clojure.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/cmake.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/cocoapods.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/dotnet.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/d_lang.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/elixir.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/flutter.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/go.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/godot.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/gradle.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/haskell.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/jupyter.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/maven.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/meson.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/mill.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/nim.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/node.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/ocaml.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/pants.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/php.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/pixi.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/python.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/react_native.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/rebar.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/ruby.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/rust.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/scala.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/swift.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/terraform.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/unity.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/unreal.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/vue.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/v_lang.toml"
    )),
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/rules/project-artifacts/zig.toml"
    )),
];

static CACHED_RULES: OnceLock<Vec<ProjectRule>> = OnceLock::new();

pub struct ProjectDetector;

impl ProjectDetector {
    pub fn get_rules() -> &'static [ProjectRule] {
        CACHED_RULES.get_or_init(|| {
            let mut list = Vec::new();
            for toml_str in BUILTIN_RULES {
                match toml::from_str::<ProjectRule>(toml_str) {
                    Ok(rule) => list.push(rule),
                    Err(e) => {
                        log::error!("Failed to parse builtin project rule: {e}");
                    }
                }
            }
            list
        })
    }

    /// Checks if a directory matches any project rule based on its entry names.
    pub fn detect_project<'a>(
        dir: &Path,
        files: &[String],
        subdirs: &[String],
    ) -> Option<&'a ProjectRule> {
        let rules = Self::get_rules();
        for rule in rules {
            for det in &rule.detection {
                if let Some(ref f) = det.marker_file {
                    if files.iter().any(|entry| entry.eq_ignore_ascii_case(f))
                        || dir.join(f).is_file()
                    {
                        return Some(rule);
                    }
                }
                if let Some(ref d) = det.marker_dir {
                    if subdirs.iter().any(|entry| entry.eq_ignore_ascii_case(d))
                        || dir.join(d).is_dir()
                    {
                        return Some(rule);
                    }
                }
                if let Some(ref ext) = det.marker_extension {
                    let dot_ext = format!(".{}", ext.trim_start_matches('.'));
                    if files
                        .iter()
                        .any(|entry| entry.to_ascii_lowercase().ends_with(&dot_ext))
                    {
                        return Some(rule);
                    }
                }
            }
        }
        None
    }
}
