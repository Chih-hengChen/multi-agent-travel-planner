import pino, { type Logger } from "pino";
import { createRegistry } from "../tools/index.js";
import { WebSearchSource } from "../data-sources/web-search-source.js";
import { SourceResolver } from "../data-sources/source-resolver.js";
import { AmadeusSource } from "../data-sources/amadeus-source.js";
import { BookingSource } from "../data-sources/booking-source.js";
import { AmapSource } from "../data-sources/amap-source.js";
import { Train12306Source } from "../data-sources/train12306-source.js";
import { FallbackDataSource } from "../data-sources/fallback-data-source.js";
import { settings } from "../config/settings.js";

const log: Logger = pino({ level: settings.LOG_LEVEL });

const webSearch = new WebSearchSource(log);

function buildSourceResolver(): SourceResolver {
  const amadeus = new AmadeusSource();
  const booking = new BookingSource();
  const amap = new AmapSource();
  const train12306 = new Train12306Source(log);

  const sources = [
    new FallbackDataSource(amadeus, webSearch, log),
    new FallbackDataSource(booking, webSearch, log),
    new FallbackDataSource(amap, webSearch, log),
    new FallbackDataSource(train12306, webSearch, log),
  ];

  return new SourceResolver(sources, log);
}

const registry = createRegistry({
  sourceResolver: buildSourceResolver(),
  log,
});

export const TOOLS = registry.getToolDefs();

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const result = await registry.execute(name, input);
  return result.success ? result.data : { error: result.error };
}

export { registry };
