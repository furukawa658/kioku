mod mcp;
mod search;
mod work_state;

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "kioku-core")]
#[command(about = "Rust MCP and local SQLite search core for kioku")]
struct Cli {
    #[arg(long)]
    database: Option<PathBuf>,

    #[arg(long, default_value = "http://127.0.0.1:37777")]
    worker_url: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let database = cli.database.unwrap_or_else(search::default_database_path);
    let worker_url = std::env::var("CLAUDE_MEM_WORKER_URL").unwrap_or(cli.worker_url);
    mcp::serve(&database, &worker_url)
}
