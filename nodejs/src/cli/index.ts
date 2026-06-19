import { Command } from "commander";

export async function runCli() {
  const program = new Command();
  program
    .name("travel-planner")
    .description("Multi-Agent Travel Planner")
    .option("-b, --budget <number>", "总预算 (CNY)", "10000")
    .option("-d, --departure <city>", "出发城市", "北京")
    .option("-s, --start <date>", "出发日期 YYYY-MM-DD", "2026-05-01")
    .option("-e, --end <date>", "返回日期 YYYY-MM-DD", "2026-05-05")
    .option("--style <style>", "旅行风格", "comfort")
    .option("-t, --travelers <n>", "人数", "1")
    .parse();

  console.error("CLI direct planning is deprecated (Pipeline removed in P0-C).");
  console.error("Use the HTTP API: POST /api/chat to open a session, then POST /api/chat/:sid with travel intent.");
  console.error("The Agent Loop (USE_AGENT_LOOP=true) will orchestrate searching/selecting/planning.");
  process.exit(1);
}
