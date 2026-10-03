using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.UObject;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Text.RegularExpressions;

namespace PalExtract;
static partial class Program
{
    // An independent reference manifest: keeps every level tier and encounter
    // variant, unlike the base-species drop slice used by the breeding pack.
    static int ExportMaterials(IFileProvider provider)
    {
        const string Root = "Pal/Content/Pal/DataTable/";
        UDataTable Table(string p) => provider.LoadPackageObject<UDataTable>(Root + p);
        var en = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_ItemNameText_Common");
        var fr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_ItemNameText_Common");
        var palsEn = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PalNameText_Common");
        var palsFr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_PalNameText_Common");
        string Text(Dictionary<string,string> t, string key, string fallback) => Clean(t.GetValueOrDefault(key, fallback));
        var monsters = Table("Character/DT_PalMonsterParameter").RowMap.ToDictionary(r=>r.Key.Text, r=>Vals(r.Value));
        var itemRows = Table("Item/DT_ItemDataTable").RowMap.ToDictionary(r=>r.Key.Text, r=>Vals(r.Value));
        var items = new SortedDictionary<string,JObject>(StringComparer.Ordinal);
        foreach (var (id,v) in itemRows) {
            if (!B(v,"bLegalInGame")) continue;
            var key = NonNone(S(v,"OverrideName")) ?? "ITEM_NAME_" + id;
            items[id] = new JObject { ["id"]=id, ["name"]=Text(en,key,id), ["name_fr"]=Text(fr,key,Text(en,key,id)),
                ["category"]=StripEnum(S(v,"TypeA")), ["subtype"]=StripEnum(S(v,"TypeB")), ["weight"]=F(v,"Weight"),
                ["sources"]=new JArray(), ["uses"]=new JArray() };
        }
        JObject Pal(string cid) {
            var id = Regex.Replace(cid, "^(BOSS_|PREDATOR_|GYM_|RAID_)", "", RegexOptions.IgnoreCase);
            var v = monsters.GetValueOrDefault(cid) ?? monsters.GetValueOrDefault(id);
            var key = v == null ? "PAL_NAME_"+id : NonNone(S(v,"OverrideNameTextID")) ?? "PAL_NAME_"+id;
            // Special encounters reuse a species' localized name but add ID
            // suffixes. Join the base species for the dex and owned counts.
            var namedId = key.StartsWith("PAL_NAME_") ? key[9..] : id;
            if (monsters.ContainsKey(namedId)) id = namedId;
            string variant = cid.StartsWith("PREDATOR_",StringComparison.OrdinalIgnoreCase) ? "predator" :
                v != null && B(v,"IsRaidBoss") ? "raid" : v != null && B(v,"IsTowerBoss") ? "tower" :
                cid.StartsWith("BOSS_",StringComparison.OrdinalIgnoreCase) ? "alpha" : "normal";
            return new JObject { ["character_id"]=cid, ["species_id"]=id, ["name"]=Text(palsEn,key,id),
                ["name_fr"]=Text(palsFr,key,Text(palsEn,key,id)), ["variant"]=variant };
        }
        void Add(string id, JObject source) { if (items.TryGetValue(id,out var item)) ((JArray)item["sources"]).Add(source); }
        var dropRows = Table("Character/DT_PalDropItem").RowMap.Select(r=>Vals(r.Value)).GroupBy(v=>S(v,"CharacterID"));
        int drops=0;
        foreach (var group in dropRows) {
            if (group.Key == null || !monsters.ContainsKey(group.Key)) continue;
            var tiers=group.OrderBy(v=>I(v,"Level")).ToArray();
            for(int j=0;j<tiers.Length;j++) for(int n=1;n<=10;n++) {
                var v=tiers[j]; var id=NonNone(S(v,"ItemId"+n)); var rate=F(v,"Rate"+n);
                if(id==null || rate<=0 || !items.ContainsKey(id)) continue;
                var source=Pal(group.Key); source["kind"]="drop";
                source["level_min"]=I(v,"Level"); if(j+1<tiers.Length) source["level_max"]=I(tiers[j+1],"Level")-1;
                source["min"]=I(v,"min"+n); source["max"]=I(v,"Max"+n); source["rate"]=rate;
                Add(id,source); drops++;
            }
            var first=NonNone(S(monsters[group.Key],"FirstDefeatRewardItemID"));
            if(first!=null) { var source=Pal(group.Key); source["kind"]="drop"; source["level_min"]=0;
                source["min"]=1; source["max"]=1; source["rate"]=100; source["first_defeat"]=true; Add(first,source); }
        }
        var lottery=Table("Item/DT_ItemLotteryDataTable").RowMap.Select(r=>Vals(r.Value)).ToArray();
        var fieldSlots=Table("Common/DT_FieldLotteryNameDataTable").RowMap.ToDictionary(r=>r.Key.Text,r=>Vals(r.Value));
        var slots=lottery.GroupBy(v=>(S(v,"FieldName"), I(v,"SlotNo"))).ToDictionary(g=>g.Key,g=>g.Sum(v=>F(v,"WeightInSlot")));
        JObject LotterySource(Dictionary<string,object> v) {
            double total=slots[(S(v,"FieldName"),I(v,"SlotNo"))];
            var field=S(v,"FieldName"); var slot=I(v,"SlotNo");
            double? slotChance=fieldSlots.TryGetValue(field,out var definition) && definition.ContainsKey("ItemSlot"+slot+"_ProbabilityPercent")
                ? F(definition,"ItemSlot"+slot+"_ProbabilityPercent") : null;
            return new JObject { ["min"]=I(v,"MinNum"), ["max"]=I(v,"MaxNum"),
                ["rate"]=total>0 ? Math.Round(F(v,"WeightInSlot")/total*(slotChance ?? 100),4) : 0,
                ["conditional_slot"]=slotChance==null, ["slot"]=slot };
        }
        var assetPaths=provider.Files.Keys.Where(p=>p.EndsWith(".uasset")).ToArray();
        List<UObject> Exports(string path) {
            var result=new List<UObject>(); if(path==null || !provider.TryLoadPackage(path,out var pkg)) return result;
            for(int i=0;i<pkg.ExportMapLength;i++) { var p=new FPackageIndex(pkg,i+1).ResolvedObject; if(p?.Object.Value is UObject o) result.Add(o); }
            return result;
        }
        object Prop(UObject obj,string key) => obj.Properties.FirstOrDefault(p=>p.Name.Text==key)?.Tag?.GenericValue;
        string StructKey(object raw) { var value=AsStruct(raw); return value==null ? null : NonNone(S(Vals(value),"Key")); }
        // Battle completion rewards live on the manager, not DT_PalDropItem.
        // In particular, World Tree arena victories award 60..80 Holy Water.
        int battles=0;
        var manager=Exports("Pal/Content/Pal/Blueprint/System/BP_PalBossBattleManager.uasset")
            .FirstOrDefault(o=>o.Name=="Default__BP_PalBossBattleManager_C");
        if(manager!=null && Prop(manager,"BossInfoMap") is UScriptMap bossInfo) foreach(var boss in bossInfo.Properties) {
            var info=AsStruct(boss.Value.GenericValue); if(info==null) continue;
            var iv=Vals(info); if(iv.GetValueOrDefault("DifficultyParameter") is not UScriptMap difficulties) continue;
            foreach(var difficulty in difficulties.Properties) {
                var definition=AsStruct(difficulty.Value.GenericValue); if(definition==null) continue;
                var dv=Vals(definition); var cid=StructKey(dv.GetValueOrDefault("PalId"));
                if(cid==null || !monsters.ContainsKey(cid)) continue;
                if(dv.GetValueOrDefault("SuccessItemList") is UScriptArray rewards) foreach(var reward in rewards.Properties) {
                    var rv=AsStruct(reward.GenericValue); if(rv==null) continue; var v=Vals(rv);
                    var id=StructKey(v.GetValueOrDefault("ItemName")); if(id==null || F(v,"Rate")<=0) continue;
                    var source=Pal(cid); source["kind"]="drop"; source["variant"]="battle";
                    source["battle_id"]=StripEnum(boss.Key.GenericValue.ToString());
                    source["difficulty"]=StripEnum(difficulty.Key.GenericValue.ToString());
                    source["level_min"]=I(dv,"Level"); source["level_max"]=I(dv,"Level");
                    source["min"]=I(v,"Min"); source["max"]=I(v,"Max"); source["rate"]=F(v,"Rate");
                    Add(id,source); battles++;
                }
                if(iv.GetValueOrDefault("OneTimeRewards") is UScriptArray firsts) foreach(var reward in firsts.Properties) {
                    var id=StructKey(reward.GenericValue); if(id==null) continue;
                    var source=Pal(cid); source["kind"]="drop"; source["variant"]="battle";
                    source["battle_id"]=StripEnum(boss.Key.GenericValue.ToString());
                    source["difficulty"]=StripEnum(difficulty.Key.GenericValue.ToString());
                    source["level_min"]=I(dv,"Level"); source["level_max"]=I(dv,"Level");
                    source["min"]=1; source["max"]=1; source["rate"]=100; source["first_defeat"]=true; Add(id,source);
                }
            }
        }
        // SpawnItem.FieldLotteryNameByRank lives on each actor's static component.
        // This rank is the game's farming suitability rank (1..10), not stars.
        int ranch=0;
        foreach(var (cid,v) in monsters.Where(p=>!p.Key.StartsWith("Quest_") && I(p.Value,"ZukanIndex")>0 && I(p.Value,"WorkSuitability_MonsterFarm")>0 && !B(p.Value,"IsBoss"))) {
            var bp=NonNone(S(v,"BPClass")) ?? cid;
            var path=assetPaths.FirstOrDefault(p=>p.Contains("/PalActorBP/") && p.EndsWith("/BP_"+bp+".uasset",StringComparison.OrdinalIgnoreCase));
            foreach(var obj in Exports(path)) {
                var spawn=AsStruct(Prop(obj,"SpawnItem"));
                if(spawn?.Properties.FirstOrDefault(p=>p.Name.Text=="FieldLotteryNameByRank")?.Tag?.GenericValue is not UScriptMap ranks) continue;
                foreach(var pair in ranks.Properties) {
                    int rank=Convert.ToInt32(pair.Key.GenericValue);
                    var row=AsStruct(pair.Value.GenericValue); var field=row==null ? null : S(Vals(row),"Key");
                    foreach(var l in lottery.Where(l=>S(l,"FieldName")==field)) {
                        var source=LotterySource(l); var pal=Pal(cid); foreach(var p in pal.Properties()) source[p.Name]=p.Value;
                        source["kind"]="ranch"; source["rank"]=rank; source["base_rank"]=I(v,"WorkSuitability_MonsterFarm");
                        source["food"]=I(v,"FoodAmount"); Add(S(l,"StaticItemId"),source); ranch++;
                    }
                }
            }
        }
        // Named non-combat reward pools. Odds are per slot, never a fabricated
        // probability for completing a whole dungeon/fishing interaction.
        foreach(var l in lottery) {
            var field=S(l,"FieldName") ?? "";
            if(!field.StartsWith("Expedition_") && !field.Contains("Fishing") && !field.Contains("Fishpond")) continue;
            var source=LotterySource(l); source["kind"]=field.StartsWith("Expedition_") ? "expedition" : "fishing";
            source["pool"]=field; Add(S(l,"StaticItemId"),source);
        }
        var shopRows=Table("ItemShop/DT_ItemShopCreateData");
        var shopCurrency=Table("ItemShop/DT_ItemShopSettingData").RowMap.ToDictionary(r=>r.Key.Text,r=>S(Vals(r.Value),"CurrencyItemID"));
        int shops=0;
        foreach(var row in shopRows.RowMap) {
            var shop=row.Key.Text; if(shop.StartsWith("Test") || shop.Contains("Skin_Shop")) continue;
            if(Vals(row.Value).GetValueOrDefault("productDataArray") is not UScriptArray products) continue;
            // Stable catalog identities; multiple caravan stock variants remain distinct.
            var name=shop.StartsWith("Caravan_") ? "Caravan merchant" : shop.StartsWith("Village_") ? "Small Settlement merchant" :
                shop.StartsWith("Desert_") ? "Duneshelter merchant" : shop.StartsWith("Volcano_") ? "Fisherman's Point merchant" :
                shop.StartsWith("Wander_") || shop.StartsWith("Vagrant_") ? "Wandering merchant" :
                shop.StartsWith("Dungeon_") ? "Dungeon merchant" : shop.StartsWith("Medal_") ? "Medal merchant" :
                shop.StartsWith("Bounty_") ? "Bounty merchant" : shop.StartsWith("Arena_") ? "Arena merchant" : shop;
            foreach(var product in products.Properties) {
                var value=AsStruct(product.GenericValue); if(value==null) continue; var v=Vals(value); var id=S(v,"StaticItemId");
                if(id==null || !items.ContainsKey(id)) continue;
                var overridePrice=F(v,"OverridePrice"); var price=overridePrice>0 ? overridePrice : F(itemRows[id],"Price");
                Add(id,new JObject { ["kind"]="merchant", ["shop_id"]=shop, ["name"]=name, ["price"]=price,
                    ["currency"]=shopCurrency.GetValueOrDefault(shop,"Money"), ["qty"]=I(v,"ProductNum"), ["stock"]=I(v,"Stock") }); shops++;
            }
        }
        foreach(var row in Table("Item/DT_ItemRecipeDataTable").RowMap) {
            var v=Vals(row.Value); var output=S(v,"Product_Id"); if(output==null || !items.ContainsKey(output)) continue;
            var ingredients=new JArray();
            for(int n=1;n<=5;n++) { var id=NonNone(S(v,"Material"+n+"_Id")); if(id!=null && items.ContainsKey(id)) ingredients.Add(new JObject { ["id"]=id,["qty"]=I(v,"Material"+n+"_Count") }); }
            if(ingredients.Count==0) continue;
            var recipe=new JObject { ["kind"]="craft", ["recipe_id"]=row.Key.Text,["qty"]=I(v,"Product_Count"),["ingredients"]=ingredients };
            Add(output,recipe);
            foreach(JObject ingredient in ingredients) ((JArray)items[(string)ingredient["id"]]["uses"]).Add(new JObject {
                ["id"]=output,["qty"]=ingredient["qty"],["output_qty"]=I(v,"Product_Count"),["recipe_id"]=row.Key.Text });
        }
        var resources=new Dictionary<string,string> { ["Stone"]="stone",["Wood"]="",["CopperOre"]="ore",["Coal"]="coal",["Sulfur"]="sulfur",
            ["Quartz"]="quartz",["Chromium"]="chromite",["Pal_crystal_S"]="paldium",["NightStone"]="nightstar",
            ["RainbowCrystal"]="hexolite",["SkyIslandOre"]="sky_ore",["WorldTreeOre"]="tree_ore",["CrudeOil"]="oil",
            ["MeteorDrop"]="meteorite",["WorldTreeHolyWater"]="healing" };
        foreach(var (id,category) in resources) if(category.Length>0 && items.ContainsKey(id)) {
            var source = new JObject { ["kind"]="gather",["category"]=category };
            Add(id,source);
        }
        // Keep resources, crafting ingredients, and obtained consumables. Gear
        // remains referencable by ID in recipes but is not a material-search hit.
        bool Visible(JObject i) => (string)i["category"]=="Material" || ((JArray)i["uses"]).Count>0 ||
            ((JArray)i["sources"]).OfType<JObject>().Any(s=>(string)s["kind"]!="craft" && (string)s["kind"]!="merchant");
        var catalog=new JArray(items.Values.Where(Visible));
        var labels=new JObject(); foreach(var (id,i) in items) labels[id]=new JObject { ["name"]=i["name"],["name_fr"]=i["name_fr"] };
        var doc=new JObject { ["meta"]=new JObject { ["game_build"]=GameBuild,["schema"]=1,["source"]="Installed game data tables and actor components" }, ["items"]=catalog,["labels"]=labels };
        if(catalog.Count<200 || drops<1000 || ranch<100 || shops<300) throw new InvalidDataException($"Materials extraction coverage too low: {catalog.Count}/{drops}/{ranch}/{shops}");
        var holy=items["WorldTreeHolyWater"]["sources"].OfType<JObject>().Where(s=>(string)s["kind"]=="drop").ToArray();
        if(!holy.Any(s=>(int)s["min"]==20 && (int)s["max"]==30 && (double)s["rate"]==100) || !holy.Any(s=>(double)s["rate"]==75)) throw new InvalidDataException("Missing Holy Water drop tiers");
        var outputDir=Path.GetFullPath(Path.Combine(OutDir,"..","..","..","app","public","data")); Directory.CreateDirectory(outputDir);
        File.WriteAllText(Path.Combine(outputDir,"materials.json"),doc.ToString(Formatting.None));
        if(!holy.Any(s=>(int)s["min"]==60 && (int)s["max"]==80 && (double)s["rate"]==100)) throw new InvalidDataException("Missing World Tree battle rewards");
        Console.WriteLine($"[materials] items={catalog.Count} drops={drops} battleRewards={battles} ranch={ranch} shops={shops} holyWaterDrops={holy.Length}");
        return 0;
    }
}
