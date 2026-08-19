use std::collections::HashSet;
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=rules");

    let rules_dir = Path::new("rules");
    if !rules_dir.exists() {
        return;
    }

    let mut rule_ids = HashSet::new();
    validate_rules_recursive(rules_dir, &mut rule_ids);
}

fn validate_rules_recursive(dir: &Path, seen_ids: &mut HashSet<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|s| s.to_str()) == Some("project-artifacts") {
                validate_project_artifacts_recursive(&path, seen_ids);
                continue;
            }
            validate_rules_recursive(&path, seen_ids);
        } else if path.extension().and_then(|s| s.to_str()) == Some("toml") {
            validate_rule_file(&path, seen_ids);
        }
    }
}

fn validate_project_artifacts_recursive(dir: &Path, seen_ids: &mut HashSet<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            validate_project_artifacts_recursive(&path, seen_ids);
        } else if path.extension().and_then(|s| s.to_str()) == Some("toml") {
            validate_project_artifact_file(&path, seen_ids);
        }
    }
}

fn validate_project_artifact_file(path: &Path, seen_ids: &mut HashSet<String>) {
    let content = fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "Failed to read project artifact rule '{}': {}",
            path.display(),
            e
        )
    });

    let toml: toml::Value = match toml::from_str(&content) {
        Ok(v) => v,
        Err(e) => panic!(
            "Syntax error in project artifact rule '{}': {}",
            path.display(),
            e
        ),
    };

    let project_table = toml
        .get("project")
        .and_then(|v| v.as_table())
        .unwrap_or_else(|| panic!("Missing [project] section in '{}'", path.display()));

    let id = project_table
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("Missing 'id' in project section '{}'", path.display()));

    if !seen_ids.insert(format!("proj_{}", id)) {
        panic!(
            "Duplicate project rule ID detected: '{}' in '{}'",
            id,
            path.display()
        );
    }

    if project_table.get("name").and_then(|v| v.as_str()).is_none() {
        panic!("Project rule '{}' is missing 'name'", id);
    }
}

fn validate_rule_file(path: &Path, seen_ids: &mut HashSet<String>) {
    let content = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("Failed to read rule file '{}': {}", path.display(), e));

    let toml: toml::Value = match toml::from_str(&content) {
        Ok(v) => v,
        Err(e) => panic!("Syntax error in TOML rule '{}': {}", path.display(), e),
    };

    let rule_table = toml
        .get("rule")
        .and_then(|v| v.as_table())
        .unwrap_or_else(|| panic!("Missing [rule] section in '{}'", path.display()));

    // 1. Validate ID and check for duplicates
    let id = rule_table
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("Missing or non-string 'id' in '{}'", path.display()));

    if !seen_ids.insert(id.to_string()) {
        panic!(
            "Duplicate rule ID detected: '{}' in '{}'",
            id,
            path.display()
        );
    }

    // 2. Validate metadata fields
    for field in &[
        "name",
        "category",
        "risk",
        "verified_at",
        "author",
        "description",
    ] {
        if rule_table.get(*field).and_then(|v| v.as_str()).is_none() {
            panic!(
                "Rule '{}' in '{}' is missing required metadata field: '{}'",
                id,
                path.display(),
                field
            );
        }
    }

    let risk = rule_table.get("risk").and_then(|v| v.as_str()).unwrap();
    let verified_rebuildable = rule_table
        .get("verified_rebuildable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let default_selected = rule_table
        .get("default_selected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 3. Reject default_selected=true unless risk=safe
    if default_selected && risk != "safe" {
        panic!(
            "Rule '{}' specifies default_selected = true but risk is '{}' (must be 'safe')",
            id, risk
        );
    }

    // 4. Validate disposal section
    if let Some(disposal) = toml.get("disposal").and_then(|v| v.as_table()) {
        let default_action = disposal
            .get("default_action")
            .and_then(|v| v.as_str())
            .unwrap_or("trash");

        if default_action == "permanent" && !verified_rebuildable {
            panic!(
                "Rule '{}' specifies disposal.default_action = 'permanent' without verified_rebuildable = true",
                id
            );
        }
    }
}
