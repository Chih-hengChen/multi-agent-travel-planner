import { Command } from "commander";
import { settings } from "../config/settings.js";

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

  if (settings.USE_AGENT_LOOP) {
    console.error("CLI direct planning not available with Agent Loop.");
    console.error("Use the HTTP API: POST /api/chat to open a session, then POST /api/chat/:sid with travel intent.");
    process.exit(1);
  }

  const { default: pino } = await import("pino");
  const { TravelStyle } = await import("../types/index.js");
  const { TravelPlanningPipeline } = await import("../orchestrator/pipeline.js");

  const opts = program.opts();
  const prefs: import("../types/index.js").UserPreferences = {
    budget: parseFloat(opts.budget as string),
    travelStyle: (opts.style as typeof TravelStyle[keyof typeof TravelStyle]) ?? TravelStyle.COMFORT,
    departureCity: opts.departure as string,
    startDate: opts.start as string,
    endDate: opts.end as string,
    numTravelers: parseInt(opts.travelers as string, 10),
    interests: [],
    dietaryRestrictions: [],
    accessibilityNeeds: [],
    notes: "",
    outboundTransportPreference: "no_preference",
    returnTransportPreference: "no_preference",
    mustVisitAttractions: [],
    departureTime: "flexible",
    budgetStrictness: "strict",
    accommodationType: "any",
    preferredHotelBrands: [],
    localTransitMode: "mixed",
    diningPreference: "mixed",
  };

  const log = pino({ level: "warn" });
  const pipeline = new TravelPlanningPipeline(log);
  const state = await pipeline.run(prefs);

  const dest = state.selectedDestination;
  const bb = state.budgetBreakdown;

  console.log("\n=== 行程规划结果 ===\n");

  if (dest) {
    console.log(`目的地: ${dest.city}, ${dest.country}`);
    console.log(`  ${dest.description}`);
    console.log(`  亮点: ${(dest.highlights ?? []).join(", ")}`);
  }

  if (state.flightResult?.recommendedOutbound) {
    const f = state.flightResult.recommendedOutbound;
    console.log(`\n去程航班: ${f.airline} ${f.flightNo}  ¥${f.price}`);
  }
  if (state.flightResult?.recommendedReturn) {
    const f = state.flightResult.recommendedReturn;
    console.log(`返程航班: ${f.airline} ${f.flightNo}  ¥${f.price}`);
  }

  if (state.hotelResult?.recommended) {
    const h = state.hotelResult.recommended;
    console.log(`\n酒店: ${h.name} (${h.starRating}星)  ¥${h.pricePerNight}/晚`);
    console.log(`  设施: ${(h.amenities ?? []).join(", ")}`);
  }

  if (state.activityResult) {
    console.log("\n每日行程:");
    for (const day of state.activityResult.dayPlans) {
      console.log(`  ${day.date}:`);
      for (const act of day.activities) {
        console.log(`    [${act.timeSlot}] ${act.name} (¥${act.price})`);
      }
    }
  }

  if (bb) {
    console.log(`\n预算明细:`);
    console.log(`  航班: ¥${bb.flightCost.toFixed(0)}`);
    console.log(`  酒店: ¥${bb.hotelCost.toFixed(0)}`);
    console.log(`  活动: ¥${bb.activityCost.toFixed(0)}`);
    console.log(`  总计: ¥${bb.totalCost.toFixed(0)} / 预算 ¥${bb.budget.toFixed(0)}`);
    console.log(`  ${bb.isWithinBudget ? "预算内" : `超预算 ¥${bb.overBudgetAmount?.toFixed(0) ?? "?"}`}`);
  }

  if (state.adjustmentRound > 0) {
    console.log(`\n经过 ${state.adjustmentRound} 轮预算调整`);
  }
  if (state.errorMessages.length > 0) {
    console.log("\n警告:");
    for (const msg of state.errorMessages) console.log(`  - ${msg}`);
  }
  console.log();
}
