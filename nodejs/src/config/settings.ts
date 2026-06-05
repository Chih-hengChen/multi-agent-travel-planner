import dotenv from "dotenv";
dotenv.config();

export const settings = Object.freeze({
  LLM_PROVIDER: process.env.LLM_PROVIDER ?? "openai",
  LLM_API_KEY: process.env.LLM_API_KEY ?? "",
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? "https://api.minimax.chat/v1",
  LLM_MODEL: process.env.LLM_MODEL ?? "MiniMax-M2.7",
  LLM_LIGHT_MODEL: process.env.LLM_LIGHT_MODEL ?? "glm-4.7",
  LLM_TEMPERATURE: parseFloat(process.env.LLM_TEMPERATURE ?? "0.7"),
  LLM_MAX_TOKENS: parseInt(process.env.LLM_MAX_TOKENS ?? "4096", 10),
  BUDGET_MAX_RETRIES: parseInt(process.env.BUDGET_MAX_RETRIES ?? "3", 10),
  PARALLEL_TIMEOUT: parseInt(process.env.PARALLEL_TIMEOUT ?? "30", 10),
  API_HOST: process.env.API_HOST ?? "0.0.0.0",
  API_PORT: parseInt(process.env.API_PORT ?? "3000", 10),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY ?? "",
  RAPIDAPI_HOST: process.env.RAPIDAPI_HOST ?? "booking-com15.p.rapidapi.com",
  AMAP_API_KEY: process.env.AMAP_API_KEY ?? "",
  SESSION_TTL_MS: parseInt(process.env.SESSION_TTL_MS ?? "7200000", 10),
  MAX_CONVERSATION_TURNS: parseInt(process.env.MAX_CONVERSATION_TURNS ?? "20", 10),
  MAX_GATHERING_TURNS: parseInt(process.env.MAX_GATHERING_TURNS ?? "6", 10),
  SEARCH_TIMEOUT_MS: parseInt(process.env.SEARCH_TIMEOUT_MS ?? "10000", 10),
  MAX_TRANSPORT_OPTIONS: parseInt(process.env.MAX_TRANSPORT_OPTIONS ?? "4", 10),
  MAX_HOTEL_OPTIONS: parseInt(process.env.MAX_HOTEL_OPTIONS ?? "3", 10),
  WEBSEARCH_DAEMON_URL: process.env.WEBSEARCH_DAEMON_URL ?? "http://127.0.0.1:3210",
  TRAIN_12306_ENABLED: process.env.TRAIN_12306_ENABLED !== "false",
});
