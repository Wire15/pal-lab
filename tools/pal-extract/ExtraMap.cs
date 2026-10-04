using System.Text.RegularExpressions;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.UObject;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace PalExtract;

static partial class Program
{
    sealed record PoiCategory(string id, string name, string icon, string group, bool default_visible = false, string flag = null, bool recurring = false);
    static readonly PoiCategory[] ExtraCategories = {
        new("watchtower", "Observation towers", "watchtower", "Landmarks", true, "FastTravelPointUnlockFlag"),
        new("dungeon", "Dungeons", "dungeon", "Landmarks", true, null, true),
        new("sealed_realm", "Sealed realms", "dungeon", "Landmarks"),
        new("oilrig", "Oil rigs", "oilrig", "Landmarks"),
        new("raid_arena", "Raid arenas", "enemy_camp", "Landmarks"),
        new("arena", "Arena", "enemy_camp", "Landmarks"),
        new("portal", "Teleportation altars", "portal", "Landmarks"),
        new("statue", "Statues of Power", "marker_0", "Landmarks"),
        // Keep the existing filter ID so saved spring visibility is preserved.
        new("healing", "World Tree Holy Water", "marker_0", "Resources", false, null, true),
        new("sanctuary", "Wildlife sanctuaries", "enemy_camp", "Landmarks"),
        new("starting_point", "Starting points", "fast_travel", "Landmarks"),
        new("ancient_lava", "Ancient lava deposits", "marker_0", "Resources", false, null, true),
        new("wild_palbox", "Wild Palbox", "base", "Landmarks"),
        new("shrine", "Ancient shrines", "treasure", "Collectibles", true, "ItemPickupObtainForInstanceFlag"),
        new("journal", "Journals", "marker_0", "Collectibles", false, "NoteObtainForInstanceFlag"),
        new("treasure_map", "Treasure map locations", "treasure", "Collectibles"),
        new("skill_fruit", "Skill fruit trees", "marker_0", "Resources", false, null, true),
        new("ore", "Ore deposits", "marker_0", "Resources", false, null, true),
        new("coal", "Coal deposits", "marker_0", "Resources", false, null, true),
        new("sulfur", "Sulfur deposits", "marker_0", "Resources", false, null, true),
        new("quartz", "Pure quartz deposits", "marker_0", "Resources", false, null, true),
        new("chromite", "Chromite deposits", "marker_0", "Resources", false, null, true),
        new("stone", "Stone deposits", "marker_0", "Resources", false, null, true),
        new("paldium", "Paldium deposits", "marker_0", "Resources", false, null, true),
        new("nightstar", "Nightstar sand", "marker_0", "Resources", false, null, true),
        new("hexolite", "Hexolite quartz deposits", "marker_0", "Resources", false, null, true),
        new("sky_ore", "Soralite deposits", "marker_0", "Resources", false, null, true),
        new("tree_ore", "Paloxite deposits", "marker_0", "Resources", false, null, true),
        new("meteorite", "Meteorite fragments", "marker_0", "Resources", false, null, true),
        new("oil", "Crude oil fields", "oilrig", "Resources"),
        new("lotus", "Lotus flowers", "marker_0", "Resources", false, null, true),
        new("food", "Wild food and plants", "marker_0", "Resources", false, null, true),
        new("loose_items", "Loose materials", "marker_0", "Resources", false, null, true),
        new("chest", "Treasure chests and loot", "treasure", "Collectibles", false, null, true),
        new("egg", "Wild eggs", "marker_0", "Collectibles", false, null, true),
        new("junk", "Junk piles", "junk", "Collectibles", false, null, true),
        new("fishing", "Fishing spots", "marker_0", "Activities", false, null, true),
        new("merchant", "Merchants", "bounty", "Activities", false, null, true),
        new("npc", "NPCs and quests", "bounty", "Activities"),
        new("enemy_camp", "Enemy camps", "enemy_camp", "Activities", false, null, true),
    };

    static string ExtraCategory(string cls)
    {
        if (cls == "BP_PalBiomeTriggerBox_WildlifeSanctuary_C") return "sanctuary";
        if (cls == "BP_LevelObject_StaticRespawnPoint_C") return "starting_point";
        if (cls == "BP_PalMapObjectSpawner_DamagableRock0022_C") return "ancient_lava";
        if (cls.StartsWith("BP_Item_PalEgg_")) return "egg";
        if (cls == "BP_LevelObject_UnlockMapPoint_C") return "watchtower";
        if (cls.StartsWith("BP_DungeonPortalMarker_")) return "dungeon";
        if (cls.StartsWith("BP_DungeonFixedEntrance_")) return "sealed_realm";
        if (cls == "BP_PalAmbientSoundArea_Oilrig_C") return "oilrig";
        if (cls == "BP_RaidBossAreaSummonAlterPoint_C") return "raid_arena";
        if (cls == "BP_ArenaEntrance_C") return "arena";
        if (cls.StartsWith("BP_LevelObject_WarpAltar_") || cls == "BP_LevelObject_SkylandWarpAlter_C") return "portal";
        if (cls == "BP_LevelObject_GoddessStatue_C") return "statue";
        if (cls == "BP_LevelObject_HealSpring_C") return "healing";
        if (cls == "BP_LevelObjectWildPalBox_C") return "wild_palbox";
        if (cls == "BP_LevelObject_ItemPickupTower_C") return "shrine";
        if (cls == "BP_LevelObject_Note_C") return "journal";
        if (cls == "BP_LevelObject_TreasureMapPoint_C") return "treasure_map";
        if (cls == "BP_LevelObject_OilField_C") return "oil";
        if (cls.StartsWith("BP_FishingSpot_") && !cls.Contains("Dungeon")) return "fishing";
        if (cls.StartsWith("BP_NPCCampSpawner_") || cls.StartsWith("BP_NPCCamp_Police_")) return "enemy_camp";
        if (cls.StartsWith("BP_MonoNPCSpawner") && !cls.Contains("BossBase") || cls.StartsWith("BP_QuestTargetNPCSpawner_") || cls.StartsWith("BP_PalTalkableLevelObject_") || cls.StartsWith("BP_TalkableLevelObject_")) return "npc";
        if (cls.StartsWith("bp_palmapobjectspawner_palegg_", StringComparison.OrdinalIgnoreCase)) return "egg";
        const string prefix = "BP_PalMapObjectSpawner_";
        if (cls.StartsWith("BP_PalMapObjectSpawnerTreasureBox_VisibleContent_")) return "chest";
        if (!cls.StartsWith(prefix)) return null;
        var suffix = cls.Substring(prefix.Length);
        if (suffix.StartsWith("SkillFruits_")) return "skill_fruit";
        if (suffix.StartsWith("Treasure_")) return "chest";
        if (suffix.StartsWith("Junk_") || suffix == "DogCoin_C") return "junk";
        if (suffix.StartsWith("Lotus_")) return "lotus";
        // This misleadingly named spawner uses DamagableRock0018, whose native
        // DropItemParameter contains Chromium. Check before the ordinary stones.
        if (suffix == "RockStone18_C") return "chromite";
        if (suffix.StartsWith("RockStone")) return "stone";
        return suffix switch {
            "RockCopper_C" => "ore", "RockCoal_C" => "coal", "Sulfur_C" => "sulfur",
            "RockQuartz_C" => "quartz", "PalCrystal_C" or "PalCrystal_Small_C" => "paldium",
            "NightStone_C" => "nightstar", "Crystal_C" => "hexolite", "RockIron_C" => "quartz",
            "SkyIslandOre_C" => "sky_ore", "WorldTreeOre_C" => "tree_ore",
            "Mushroom_C" or "CaveMushroom_C" or "RedBerry_C" or "Poppy_C" or "AffectionFruit_C" or "YakushimaMushroom_01_C" or "YakushimaMushroom_02_C" => "food",
            "SmallStone_C" or "log_C" or "bone_C" or "Yakushima_Pot_C" or "Yakushima_Crystal_C" => "loose_items",
            _ => null,
        };
    }

    // An attached root's RelativeLocation is local to its parent. Walk every parent,
    // applying its scale and Unreal pitch/yaw/roll before translating. Do not publish
    // a local coordinate if an attachment cannot be resolved or contains a cycle.
    static (double x, double y, double z)? ComponentWorldPosition(UObject component)
    {
        var loc = component.GetOrDefault("RelativeLocation", new FVector());
        double x = loc.X, y = loc.Y, z = loc.Z;
        var seen = new HashSet<UObject> { component };
        for (int depth = 0; depth < 64; depth++) {
            var parentIndex = component.GetOrDefault<FPackageIndex>("AttachParent");
            if (parentIndex == null || parentIndex.IsNull) return (x, y, z);
            var parent = parentIndex.Load();
            if (parent == null || !seen.Add(parent)) return null;
            var scale = parent.GetOrDefault("RelativeScale3D", new FVector(1, 1, 1));
            var rotation = parent.GetOrDefault("RelativeRotation", new FRotator());
            var translation = parent.GetOrDefault("RelativeLocation", new FVector());
            (x, y, z) = ApplyParentTransform((x, y, z), scale, rotation, translation);
            component = parent;
        }
        return null;
    }

    static (double x, double y, double z) ApplyParentTransform((double x, double y, double z) point, FVector scale, FRotator rotation, FVector translation)
    {
        var p = rotation.Pitch * Math.PI / 180; var a = rotation.Yaw * Math.PI / 180; var r = rotation.Roll * Math.PI / 180;
        double cp = Math.Cos(p), sp = Math.Sin(p), cy = Math.Cos(a), sy = Math.Sin(a), cr = Math.Cos(r), sr = Math.Sin(r);
        double x = point.x * scale.X, y = point.y * scale.Y, z = point.z * scale.Z;
        return (cp*cy*x+(sr*sp*cy-cr*sy)*y+(-cr*sp*cy-sr*sy)*z+translation.X,
            cp*sy*x+(sr*sp*sy+cr*cy)*y+(-cr*sp*sy+sr*cy)*z+translation.Y,
            sp*x-sr*cp*y+cr*cp*z+translation.Z);
    }

    static int CheckMapTransforms()
    {
        void Check((double x, double y, double z) actual, (double x, double y, double z) expected) {
            if (Math.Abs(actual.x-expected.x)>0.001 || Math.Abs(actual.y-expected.y)>0.001 || Math.Abs(actual.z-expected.z)>0.001)
                throw new InvalidDataException($"Incorrect component transform: {actual}, expected {expected}");
        }
        var unit = new FVector(1,1,1);
        Check(ApplyParentTransform((1,2,3), unit, new FRotator(), new FVector(10,20,30)), (11,22,33));
        Check(ApplyParentTransform((1,0,0), unit, new FRotator(0,90,0), new FVector()), (0,1,0));
        Check(ApplyParentTransform((1,0,0), unit, new FRotator(90,0,0), new FVector()), (0,0,1));
        Check(ApplyParentTransform((0,1,0), unit, new FRotator(0,0,90), new FVector()), (0,0,-1));
        var child = ApplyParentTransform((1,2,3), new FVector(2,3,4), new FRotator(0,90,0), new FVector(10,20,30));
        Check(child, (4,22,42));
        Check(ApplyParentTransform(child, unit, new FRotator(0,90,0), new FVector(100,200,300)), (78,204,342));
        Console.WriteLine("[map-transforms] translation, nonuniform scale, yaw/pitch/roll and nested parents passed");
        return 0;
    }

    static int ExportExtraMap(IFileProvider provider)
    {
        var mapDir = Path.GetFullPath(Path.Combine(OutDir, "..", "..", "..", "app", "public", "map"));
        var path = Path.Combine(mapDir, "map-data.json");
        var doc = JObject.Parse(File.ReadAllText(path));
        if ((string)doc["meta"]?["game_build"] != GameBuild) throw new InvalidDataException("Base map build differs; run --export-map first.");
        var notesEn = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_NoteDescText");
        var notesFr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_NoteDescText");
        var ftNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_MapRespawnPointInfoText");
        var ftFr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_MapRespawnPointInfoText");
        var npcEn = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_UniqueNPCText_Common");
        var npcFr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_UniqueNPCText_Common");
        var humanEn = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_HumanNameText_Common");
        var humanFr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_HumanNameText_Common");
        var humanRows = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalHumanParameter").RowMap.ToDictionary(r=>r.Key.Text, r=>Vals(r.Value));
        var unique = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_UniqueNPC").RowMap.ToDictionary(r => r.Key.Text, r => Vals(r.Value));
        var definitions = ExtraCategories.ToDictionary(c => c.id);
        var blueprintFiles = provider.Files.Values.Where(f => f.Path.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
            .GroupBy(f => Path.GetFileNameWithoutExtension(f.Path) + "_C").ToDictionary(g => g.Key, g => g.First());
        var defaults = new Dictionary<string, UObject>();
        UObject Default(string cls) {
            if (defaults.TryGetValue(cls, out var cached)) return cached;
            UObject result = null;
            if (blueprintFiles.TryGetValue(cls, out var file) && provider.TryLoadPackage(file, out var pkg))
                for (int i=0; i<pkg.ExportMapLength; i++) {
                    var ptr = new FPackageIndex(pkg, i+1).ResolvedObject;
                    if (ptr?.Name.Text.StartsWith("Default__") == true) { result = ptr.Object.Value; break; }
                }
            defaults[cls] = result; return result;
        }
        string Key(UObject actor, string cls, string prop) {
            var raw = actor?.Properties.FirstOrDefault(p => p.Name.Text == prop)?.Tag?.GenericValue
                ?? Default(cls)?.Properties.FirstOrDefault(p => p.Name.Text == prop)?.Tag?.GenericValue;
            var s = AsStruct(raw);
            return s == null ? raw?.ToString() : s.Properties.FirstOrDefault(p => p.Name.Text == "Key")?.Tag?.GenericValue?.ToString();
        }
        // Verify the resource's identity from native blueprint data, rather than
        // trusting the RockStone18 name across game builds.
        if (Key(Default("BP_PalMapObjectSpawner_RockStone18_C"), "BP_PalMapObjectSpawner_RockStone18_C", "MapObjectId") != "DamagableRock0018")
            throw new InvalidDataException("Chromite spawner identity changed; inspect before publishing.");
        if (!blueprintFiles.TryGetValue("BP_MapObject_DamagableRock0018_C", out var chromiteFile) || !provider.TryLoadPackage(chromiteFile, out var chromitePackage))
            throw new InvalidDataException("Chromite resource blueprint is missing.");
        bool dropsChromite = false;
        for (int i=0; i<chromitePackage.ExportMapLength; i++) {
            var obj = new FPackageIndex(chromitePackage, i+1).ResolvedObject?.Object?.Value;
            if (obj?.Properties.FirstOrDefault(p=>p.Name.Text=="DropItems")?.Tag?.GenericValue is not CUE4Parse.UE4.Assets.Objects.UScriptArray drops) continue;
            foreach (var drop in drops.Properties) {
                var row = AsStruct(drop.GenericValue);
                var item = AsStruct(row?.Properties.FirstOrDefault(p=>p.Name.Text=="StaticItemId")?.Tag?.GenericValue);
                if (item?.Properties.FirstOrDefault(p=>p.Name.Text=="Key")?.Tag?.GenericValue?.ToString() == "Chromium") dropsChromite = true;
            }
        }
        if (!dropsChromite) throw new InvalidDataException("Chromite blueprint no longer drops Chromium; inspect before publishing.");
        var springItems = Default("BP_LevelObject_HealSpring_C")?.Properties.FirstOrDefault(p=>p.Name.Text=="ObtainItemInfos")?.Tag?.GenericValue
            as CUE4Parse.UE4.Assets.Objects.UScriptArray;
        bool givesHolyWater = springItems?.Properties.Any(p=> {
            var row=AsStruct(p.GenericValue);
            var item=AsStruct(row?.Properties.FirstOrDefault(p=>p.Name.Text=="StaticItemId")?.Tag?.GenericValue);
            return item?.Properties.FirstOrDefault(p=>p.Name.Text=="Key")?.Tag?.GenericValue?.ToString()=="WorldTreeHolyWater";
        }) == true;
        if (!givesHolyWater) throw new InvalidDataException("Spring reward changed; inspect before publishing a holy-water source.");
        var points = new List<object>(); var seen = new HashSet<(string, long, long, long)>();
        var audit = new System.Text.StringBuilder(); var audited = new HashSet<string>();
        var translations = new SortedDictionary<string, string>(); int unresolved = 0, outside = 0, duplicates = 0, interiors = 0;
        var itemEn = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_ItemNameText_Common");
        var itemFr = LoadText(provider, "Pal/Content/L10N/fr/Pal/DataTable/Text/DT_ItemNameText_Common");
        if (!itemEn.TryGetValue("ITEM_NAME_WorldTreeHolyWater",out var holyWaterEn) || !itemFr.TryGetValue("ITEM_NAME_WorldTreeHolyWater",out var holyWaterFr)
            || Clean(holyWaterEn) != definitions["healing"].name)
            throw new InvalidDataException("Holy-water item localization changed; inspect before publishing.");
        translations[Clean(holyWaterEn)] = Clean(holyWaterFr);
        var counts = new SortedDictionary<string, int>();
        foreach (var file in provider.Files.Values.Where(f => f.Path.EndsWith(".umap", StringComparison.OrdinalIgnoreCase) && f.Path.Contains("Pal/Content/Pal/Maps/MainWorld_5/", StringComparison.OrdinalIgnoreCase)).OrderBy(f => f.Path, StringComparer.Ordinal)) {
            if (!provider.TryLoadPackage(file, out var pkg)) continue;
            for (int i=0; i<pkg.ExportMapLength; i++) {
                var ptr = new FPackageIndex(pkg, i+1).ResolvedObject; var cls = ptr?.Class?.Name.Text;
                var category = cls == null ? null : ExtraCategory(cls);
                if (category == null) continue;
                var actor = ptr.Object.Value;
                var component = actor.GetOrDefault<FPackageIndex>("RootComponent")?.Load();
                var loc = component == null ? null : ComponentWorldPosition(component);
                if (loc == null) { unresolved++; continue; }
                var (x,y,z) = loc.Value;
                // The world-partition package also embeds dungeon/arena templates at
                // Z=-50,000 to -80,000. Their contents have no outdoor map location.
                if (z < -20000) { interiors++; continue; }
                string map = null;
                // Tree bounds are separate from MainMap; use the same layer priority as ExportMap.
                foreach (var m in doc["maps"].Children<JProperty>().OrderBy(m => m.Name == "Tree" ? 0 : 1)) {
                    var min = m.Value["world_min"]; var max = m.Value["world_max"];
                    if (x >= (double)min[0] && y >= (double)min[1] && x <= (double)max[0] && y <= (double)max[1]) { map=m.Name; break; }
                }
                if (map == null) { outside++; continue; }
                var id = actor.GetOrDefault<FGuid>("LevelObjectInstanceId");
                var guid = (id.A|id.B|id.C|id.D) != 0 ? UeDigits(id) : null;
                string saveKey = null, name = null, detail = null;
                if (category == "watchtower") {
                    var key = Key(actor, cls, "FastTravelPointID"); saveKey = guid;
                    if (key != null && ftNames.TryGetValue(key, out var en)) {
                        name = Clean(en); if (ftFr.TryGetValue(key, out var fr)) translations[name] = Clean(fr);
                    }
                }
                if (category == "shrine") saveKey = guid;
                if (category == "journal") {
                    saveKey = Key(actor, cls, "NoteRowName");
                    if (saveKey != null && notesEn.TryGetValue(saveKey, out var en)) {
                        name=Clean(en.Split('\n')[0]);
                        if (notesFr.TryGetValue(saveKey, out var fr)) translations[name]=Clean(fr.Split('\n')[0]);
                    } else detail=saveKey;
                }
                if (audited.Add(cls)) { audit.AppendLine("CLASS " + cls); if (Default(cls) is {} cdo) DumpStruct(cdo, audit, "  "); }
                if (category == "npc") {
                    var key = Key(actor, cls, "UniqueName");
                    if (key != null && unique.TryGetValue(key, out var row)) {
                        var cid = S(row, "CharacterID"); var textId = S(row, "NameTextID");
                        if (cid?.Contains("Trader", StringComparison.OrdinalIgnoreCase) == true || S(row, "OneTalkDTName")?.Contains("Shop", StringComparison.OrdinalIgnoreCase) == true) category="merchant";
                        if (textId != null && npcEn.TryGetValue(textId, out var en)) { name=Clean(en); if (npcFr.TryGetValue(textId,out var fr)) translations[name]=Clean(fr); }
                    }
                    var human = Key(actor, cls, "HumanName");
                    if (human?.Contains("Dungeon", StringComparison.OrdinalIgnoreCase) == true) { interiors++; continue; }
                    if (name == null && human != null && humanRows.TryGetValue(human, out var hv)) {
                        var textId = S(hv, "OverrideNameTextID");
                        if (textId != null && humanEn.TryGetValue(textId, out var en)) { name=Clean(en); if (humanFr.TryGetValue(textId,out var fr)) translations[name]=Clean(fr); }
                    }
                    if (human?.StartsWith("SalesPerson") == true || human?.StartsWith("PalDealer") == true) category="merchant";
                    if (name == null) { audit.AppendLine("NPC " + cls); DumpStruct(actor, audit, "  "); }
                    if (name?.Contains("Merchant", StringComparison.OrdinalIgnoreCase) == true || name?.Contains("Marketeer", StringComparison.OrdinalIgnoreCase) == true) category="merchant";
                    if (cls.Contains("MedalTrader")) { category="merchant"; name="Medal Merchant"; }
                }
                if (category == "fishing" && cls.Contains("Rare")) detail="Rare fishing spot";
                if (category == "chromite") detail="Reveal with a Metal Detector or Smokie";
                if (category == "healing") detail="Teafant spring";
                var def=definitions[category];
                if (!seen.Add((category, (long)Math.Round(x*10), (long)Math.Round(y*10), (long)Math.Round(z*10)))) { duplicates++; continue; }
                points.Add(new { x=Math.Round(x,2), y=Math.Round(y,2), z=Math.Round(z,2), map, category, name, detail, guid, save_key=saveKey });
                counts[category]=counts.GetValueOrDefault(category)+1;
            }
        }
        if (counts.GetValueOrDefault("watchtower") != 22 || counts.GetValueOrDefault("dungeon") != 170 || counts.GetValueOrDefault("shrine") != 106 || counts.GetValueOrDefault("journal") != 64 || counts.GetValueOrDefault("skill_fruit") != 43 || counts.GetValueOrDefault("chromite") != 257 || counts.GetValueOrDefault("healing") != 3)
            throw new InvalidDataException("Static landmark/collectible count changed; inspect extraction before publishing: " + JsonConvert.SerializeObject(counts));
        doc["poi_categories"] = JArray.FromObject(ExtraCategories.Where(c=>counts.ContainsKey(c.id)));
        doc["points_of_interest"] = JArray.FromObject(points, JsonSerializer.Create(new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore }));
        File.WriteAllText(path, doc.ToString(Formatting.None));
        var probe = Path.GetFullPath(Path.Combine(mapDir, "..", "..", "..", "testdata", "probe"));
        Directory.CreateDirectory(probe);
        File.WriteAllText(Path.Combine(probe,"extra-map-defaults.log"), audit.ToString());
        File.WriteAllText(Path.Combine(probe,"extra-map-fr.json"), JsonConvert.SerializeObject(translations, Formatting.Indented));
        Console.WriteLine($"[extra-map] {points.Count} points; unresolved={unresolved}, outside-map={outside}, interior={interiors}, duplicate={duplicates}; " + JsonConvert.SerializeObject(counts));
        return 0;
    }
}
