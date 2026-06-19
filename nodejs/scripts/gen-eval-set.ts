import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

interface EvalQuery {
  id: string;
  category: "attraction" | "food" | "itinerary" | "tips" | "transport";
  city: string;
  query: string;
  groundTruthDocIds: string[];
}

const TEMPLATES: Record<string, Array<{ category: EvalQuery["category"]; query: string; expected: string[] }>> = {
  "北京": [
    { category: "attraction", query: "故宫怎么玩", expected: ["故宫", "紫禁城"] },
    { category: "attraction", query: "长城哪段人少", expected: ["慕田峪", "八达岭"] },
    { category: "attraction", query: "颐和园游玩路线", expected: ["颐和园", "昆明湖"] },
    { category: "attraction", query: "天坛公园开放时间", expected: ["天坛", "祈年殿"] },
    { category: "food", query: "北京必吃美食", expected: ["烤鸭", "炸酱面"] },
    { category: "food", query: "涮肉推荐", expected: ["涮肉", "铜锅"] },
    { category: "food", query: "豆汁哪里正宗", expected: ["豆汁", "焦圈"] },
    { category: "itinerary", query: "三天行程安排", expected: ["天安门", "故宫", "长城"] },
    { category: "itinerary", query: "五日深度游", expected: ["故宫", "颐和园", "长城"] },
    { category: "itinerary", query: "亲子一日游", expected: ["动物园", "天文馆"] },
    { category: "tips", query: "最佳旅游季节", expected: ["秋季", "9月"] },
    { category: "tips", query: "交通卡怎么办", expected: ["一卡通", "地铁"] },
    { category: "tips", query: "避坑指南", expected: ["南锣鼓巷", "簋街"] },
    { category: "tips", query: "天气怎么样", expected: ["干燥", "春季"] },
    { category: "transport", query: "机场到市区怎么走", expected: ["首都机场", "大兴机场"] },
    { category: "transport", query: "地铁线路图", expected: ["1号线", "2号线"] },
    { category: "transport", query: "高铁站哪个近", expected: ["北京南站", "北京西站"] },
    { category: "transport", query: "打车贵不贵", expected: ["起步价", "13元"] },
    { category: "transport", query: "公交怎么坐", expected: ["公交", "BRT"] },
    { category: "transport", query: "共享单车", expected: ["美团", "哈啰"] },
  ],
  "上海": [
    { category: "attraction", query: "外滩夜景", expected: ["外滩", "东方明珠"] },
    { category: "attraction", query: "迪士尼攻略", expected: ["迪士尼", "奇幻童话"] },
    { category: "attraction", query: "豫园好玩吗", expected: ["豫园", "城隍庙"] },
    { category: "attraction", query: "田子坊逛什么", expected: ["田子坊", "石库门"] },
    { category: "food", query: "小笼包推荐", expected: ["小笼", "生煎"] },
    { category: "food", query: "本帮菜特色", expected: ["红烧肉", "本帮"] },
    { category: "food", query: "蟹壳黄哪里买", expected: ["蟹壳黄", "烘饼"] },
    { category: "itinerary", query: "周末两日游", expected: ["外滩", "豫园"] },
    { category: "itinerary", query: "亲子迪士尼", expected: ["迪士尼", "动物"] },
    { category: "itinerary", query: "文艺路线", expected: ["美术馆", "博物馆"] },
    { category: "tips", query: "梅雨季节", expected: ["6月", "潮湿"] },
    { category: "tips", query: "交通卡办哪种", expected: ["交通卡", "地铁"] },
    { category: "tips", query: "购物去哪里", expected: ["南京路", "淮海路"] },
    { category: "tips", query: "免费景点", expected: ["外滩", "博物馆"] },
    { category: "transport", query: "浦东机场到市区", expected: ["浦东机场", "磁悬浮"] },
    { category: "transport", query: "虹桥枢纽", expected: ["虹桥", "高铁"] },
    { category: "transport", query: "地铁换乘", expected: ["人民广场", "换乘"] },
    { category: "transport", query: "轮渡攻略", expected: ["轮渡", "黄浦江"] },
    { category: "transport", query: "打车软件", expected: ["滴滴", "美团"] },
    { category: "transport", query: "自行车道", expected: ["滨江", "骑行"] },
  ],
  "成都": [
    { category: "attraction", query: "大熊猫基地", expected: ["熊猫", "繁育基地"] },
    { category: "attraction", query: "宽窄巷子", expected: ["宽窄巷子", "井巷子"] },
    { category: "attraction", query: "武侯祠历史", expected: ["武侯祠", "三国"] },
    { category: "attraction", query: "都江堰一日游", expected: ["都江堰", "青城山"] },
    { category: "food", query: "火锅哪家好", expected: ["火锅", "川菜"] },
    { category: "food", query: "钵钵鸡特色", expected: ["钵钵鸡", "冷锅"] },
    { category: "food", query: "担担面推荐", expected: ["担担面", "龙抄手"] },
    { category: "itinerary", query: "三日游路线", expected: ["熊猫", "武侯祠", "宽窄巷子"] },
    { category: "itinerary", query: "周末周边游", expected: ["都江堰", "青城山"] },
    { category: "itinerary", query: "夜景打卡", expected: ["九眼桥", "兰桂坊"] },
    { category: "tips", query: "什么时候去", expected: ["春秋", "3-6月"] },
    { category: "tips", query: "茶馆文化", expected: ["茶馆", "人民公园"] },
    { category: "tips", query: "看川剧", expected: ["川剧", "变脸"] },
    { category: "tips", query: "免费景点", expected: ["锦里", "人民公园"] },
    { category: "transport", query: "双流机场到市区", expected: ["双流", "地铁"] },
    { category: "transport", query: "天府机场", expected: ["天府", "新机场"] },
    { category: "transport", query: "地铁线路", expected: ["1号线", "2号线"] },
    { category: "transport", query: "公交卡", expected: ["天府通", "公交"] },
    { category: "transport", query: "高铁到重庆", expected: ["成渝高铁", "1小时"] },
    { category: "transport", query: "共享电单车", expected: ["青桔", "美团"] },
  ],
  "西安": [
    { category: "attraction", query: "兵马俑门票", expected: ["兵马俑", "秦始皇"] },
    { category: "attraction", query: "大雁塔音乐喷泉", expected: ["大雁塔", "喷泉"] },
    { category: "attraction", query: "华清池温泉", expected: ["华清池", "骊山"] },
    { category: "attraction", query: "回民街美食", expected: ["回民街", "清真"] },
    { category: "food", query: "肉夹馍哪家正宗", expected: ["肉夹馍", "腊汁"] },
    { category: "food", query: "羊肉泡馍吃法", expected: ["羊肉泡馍", "饦饦馍"] },
    { category: "food", query: "biangbiang面", expected: ["biang", "油泼"] },
    { category: "itinerary", query: "两日游路线", expected: ["城墙", "兵马俑"] },
    { category: "itinerary", query: "文化深度游", expected: ["碑林", "陕历博"] },
    { category: "itinerary", query: "华山一日游", expected: ["华山", "索道"] },
    { category: "tips", query: "最佳季节", expected: ["春秋", "9-11月"] },
    { category: "tips", query: "城墙上骑车", expected: ["城墙", "自行车"] },
    { category: "tips", query: "夜游推荐", expected: ["大唐不夜城", "钟楼"] },
    { category: "tips", query: "汉服体验", expected: ["汉服", "大唐"] },
    { category: "transport", query: "咸阳机场到市区", expected: ["咸阳", "机场大巴"] },
    { category: "transport", query: "地铁线路", expected: ["1号线", "2号线"] },
    { category: "transport", query: "高铁到华山", expected: ["华山北", "高铁"] },
    { category: "transport", query: "公交查询", expected: ["长安通", "公交"] },
    { category: "transport", query: "打车费用", expected: ["起步价", "9元"] },
    { category: "transport", query: "火车站哪个", expected: ["西安站", "西安北"] },
  ],
  "广州": [
    { category: "attraction", query: "广州塔多高", expected: ["广州塔", "小蛮腰"] },
    { category: "attraction", query: "陈家祠建筑", expected: ["陈家祠", "岭南"] },
    { category: "attraction", query: "白云山徒步", expected: ["白云山", "摩星岭"] },
    { category: "attraction", query: "长隆野生动物园", expected: ["长隆", "野生动物"] },
    { category: "food", query: "早茶去哪家", expected: ["早茶", "陶陶居"] },
    { category: "food", query: "肠粉做法", expected: ["肠粉", "布拉"] },
    { category: "food", query: "煲仔饭推荐", expected: ["煲仔饭", "腊味"] },
    { category: "itinerary", query: "三日游路线", expected: ["广州塔", "陈家祠", "沙面"] },
    { category: "itinerary", query: "亲子长隆", expected: ["长隆", "熊猫"] },
    { category: "itinerary", query: "老广州风情", expected: ["沙面", "上下九"] },
    { category: "tips", query: "什么时候去", expected: ["秋冬", "10-12月"] },
    { category: "tips", query: "粤语常用语", expected: ["粤语", "靓仔"] },
    { category: "tips", query: "天气怎么样", expected: ["潮湿", "回南天"] },
    { category: "tips", query: "免费景点", expected: ["沙面", "越秀公园"] },
    { category: "transport", query: "白云机场到市区", expected: ["白云", "地铁"] },
    { category: "transport", query: "地铁线路", expected: ["1号线", "3号线"] },
    { category: "transport", query: "高铁到深圳", expected: ["广深港", "福田"] },
    { category: "transport", query: "羊城通", expected: ["羊城通", "公交"] },
    { category: "transport", query: "BRT快速公交", expected: ["BRT", "天河"] },
    { category: "transport", query: "渡轮珠江", expected: ["渡轮", "珠江"] },
  ],
};

function main() {
  const out: EvalQuery[] = [];
  for (const [city, templates] of Object.entries(TEMPLATES)) {
    templates.forEach((t, idx) => {
      out.push({
        id: `${city}-${t.category}-${String(idx + 1).padStart(3, "0")}`,
        category: t.category,
        city,
        query: t.query,
        groundTruthDocIds: t.expected.map(k => `travel_guides_${city}_${k}`),
      });
    });
  }

  const outputDir = "data/rag";
  mkdirSync(outputDir, { recursive: true });
  const outPath = resolve(outputDir, "eval-v1.jsonl");
  writeFileSync(outPath, out.map(q => JSON.stringify(q)).join("\n") + "\n", "utf-8");

  const byCategory: Record<string, number> = {};
  for (const q of out) byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
  const byCity: Record<string, number> = {};
  for (const q of out) byCity[q.city] = (byCity[q.city] ?? 0) + 1;

  console.log(`[OK] ${outPath}`);
  console.log(`Total: ${out.length}`);
  console.log(`By category: ${JSON.stringify(byCategory)}`);
  console.log(`By city: ${JSON.stringify(byCity)}`);
}

main();
