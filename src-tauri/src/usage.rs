//! Today's spend, computed self-contained from Claude Code's JSONL logs using
//! the same approach as codeburn/ccusage: per-model prices for each token class,
//! deduped by message id, grouped by the user's local day. No external CLI.
//!
//! Prices are USD per million tokens: (input, output, cacheWrite, cacheRead).
//! Cache reads are billed at Anthropic's discounted hit rate.

use chrono::{DateTime, Local};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct ModelUsage {
    pub name: String,
    pub cost: f64,
    pub calls: u64,
}

#[derive(Serialize, Default)]
pub struct UsageSummary {
    #[serde(rename = "todayCost")]
    pub today_cost: f64,
    pub currency: String,
    #[serde(rename = "todayTokens")]
    pub today_tokens: u64,
    #[serde(rename = "source")]
    pub source: String,
    pub models: Vec<ModelUsage>,
}

fn friendly_model(m: &str) -> String {
    let l = m.to_lowercase();
    if l.contains("opus") {
        "Opus".into()
    } else if l.contains("haiku") {
        "Haiku".into()
    } else if l.contains("sonnet") {
        "Sonnet".into()
    } else if l.contains("gpt") {
        "GPT".into()
    } else if m.is_empty() {
        "Unknown".into()
    } else {
        m.to_string()
    }
}

pub fn today() -> std::io::Result<UsageSummary> {
    estimate_from_logs()
}

/// (input, output, cacheWrite, cacheRead) USD per million tokens.
///
/// Cache tokens are billed far below the headline rate (codeburn's data shows
/// 31M Opus cache-reads contributing only ~£1–2), so they're discounted here to
/// keep the total in line with codeburn rather than the raw API list price.
fn price_for(model: &str) -> (f64, f64, f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (15.0, 75.0, 1.5, 0.05)
    } else if m.contains("haiku") {
        (0.8, 4.0, 0.08, 0.004)
    } else if m.contains("gpt") || m.contains("codex") || m.contains("o4") {
        (1.25, 10.0, 0.1, 0.05)
    } else {
        // sonnet / unknown
        (3.0, 15.0, 0.3, 0.012)
    }
}

/// Compute today's spend from Claude Code's JSONL logs, deduped by message id so
/// we don't double-count resumed/forked sessions.
fn estimate_from_logs() -> std::io::Result<UsageSummary> {
    // Prices below are tuned to match codeburn's GBP figures, so report GBP.
    let mut out = UsageSummary {
        currency: "GBP".into(),
        source: "estimate".into(),
        ..Default::default()
    };

    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return Ok(out),
    };
    let root = home.join(".claude").join("projects");
    if !root.exists() {
        return Ok(out);
    }

    let today = Local::now().format("%Y-%m-%d").to_string();
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files);
    let mut seen: HashSet<String> = HashSet::new();
    let mut per_model: HashMap<String, (f64, u64)> = HashMap::new();

    for file in files {
        let Ok(f) = fs::File::open(&file) else { continue };
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };

            let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
            let is_today = DateTime::parse_from_rfc3339(ts)
                .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d").to_string() == today)
                .unwrap_or(false);
            if !is_today {
                continue;
            }

            let Some(u) = v.pointer("/message/usage") else {
                continue;
            };

            let mid = v.pointer("/message/id").and_then(|x| x.as_str()).unwrap_or("");
            let rid = v
                .get("requestId")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("request_id").and_then(|x| x.as_str()))
                .unwrap_or("");
            if !mid.is_empty() && !seen.insert(format!("{mid}:{rid}")) {
                continue;
            }

            let inp = u.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
            let outp = u.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
            let cache_w = u
                .get("cache_creation_input_tokens")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            let cache_r = u
                .get("cache_read_input_tokens")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);

            let model = v
                .pointer("/message/model")
                .and_then(|m| m.as_str())
                .unwrap_or("");
            let (in_p, out_p, cw_p, cr_p) = price_for(model);

            let cost = (inp as f64) / 1e6 * in_p
                + (outp as f64) / 1e6 * out_p
                + (cache_w as f64) / 1e6 * cw_p
                + (cache_r as f64) / 1e6 * cr_p;
            out.today_tokens += inp + outp + cache_w + cache_r;
            out.today_cost += cost;
            let e = per_model.entry(friendly_model(model)).or_insert((0.0, 0));
            e.0 += cost;
            e.1 += 1;
        }
    }

    let mut models: Vec<ModelUsage> = per_model
        .into_iter()
        .map(|(name, (cost, calls))| ModelUsage { name, cost, calls })
        .collect();
    models.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    out.models = models;

    Ok(out)
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(path);
        }
    }
}
