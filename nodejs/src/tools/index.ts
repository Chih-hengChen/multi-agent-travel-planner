import { ToolRegistry } from "./registry.js";
import { createCollectPreferencesTool } from "./definitions/collect-preferences.js";
import { createPlanTravelTool } from "./definitions/plan-travel.js";
import { createSearchXhsTool } from "./definitions/search-xhs.js";
import { createSearchWebTool } from "./definitions/search-web.js";
import { createSearchTrainsTool } from "./definitions/search-trains.js";
import { createSearchFlightsTool } from "./definitions/search-flights.js";
import { createSearchHotelsTool } from "./definitions/search-hotels.js";
import { createSearchAttractionsTool } from "./definitions/search-attractions.js";
import { createSearchBaikeTool } from "./definitions/search-baike.js";
import { createSearchWeatherTool } from "./definitions/search-weather.js";
import { createSearchTravelGuidesTool } from "./definitions/search-travel-guides.js";
import type { SourceResolver } from "../data-sources/source-resolver.js";
import type { Logger } from "pino";

export interface RegistryDeps {
  sourceResolver: SourceResolver;
  log?: Logger;
}

export function createRegistry(deps: RegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(createCollectPreferencesTool());
  registry.register(createPlanTravelTool(deps.log));
  registry.register(createSearchXhsTool(deps.log));
  registry.register(createSearchWebTool(undefined, deps.log));
  registry.register(createSearchTrainsTool(deps.sourceResolver, deps.log));
  registry.register(createSearchFlightsTool(deps.sourceResolver, deps.log));
  registry.register(createSearchHotelsTool(deps.sourceResolver, deps.log));
  registry.register(createSearchAttractionsTool(deps.sourceResolver, deps.log));
  registry.register(createSearchBaikeTool());
  registry.register(createSearchWeatherTool());
  registry.register(createSearchTravelGuidesTool());

  return registry;
}
