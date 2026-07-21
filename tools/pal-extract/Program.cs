using System.Text.RegularExpressions;
using CUE4Parse.Compression;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.i18N;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json;
using SkiaSharp;

namespace PalExtract;

static class Program
{
    // Known build of the installed Palworld (per project constraints / build 24181527).
    const string GameBuild = "24181527";
    const string UsmapSource = "PalworldModding/UsefulFiles@1.0";

    static readonly string PaksDir = Environment.GetEnvironmentVariable("PALCALC_PALWORLD_PAKS")
        ?? @"C:\Program Files (x86)\Steam\steamapps\common\Palworld\Pal\Content\Paks";
    static readonly string UsmapPath = Environment.GetEnvironmentVariable("PALCALC_MAPPINGS_USMAP")
        ?? Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "Mappings.usmap");
    static readonly string OutDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "out"));

    // T_Icon_element sprite index -> element kind (canonical order, cf. palcalc BuildDBProgram.ExportElementIcons)
    static readonly string[] IconKinds = { "Normal", "Fire", "Water", "Electricity", "Leaf", "Dark", "Dragon", "Earth", "Ice" };

    static readonly Regex Ws = new(@"[ \t]+");
    static readonly Regex RichTag = new(@"<[^>]+>");

    static int Main(string[] args)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        OodleHelper.DownloadOodleDll();
        OodleHelper.Initialize();

        var provider = new DefaultFileProvider(PaksDir, SearchOption.AllDirectories, true, new VersionContainer(EGame.GAME_UE5_1));
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(Path.GetFullPath(UsmapPath));
        provider.Initialize();
        provider.Mount();
        provider.LoadVirtualPaths();
        Console.WriteLine($"[mount] files={provider.Files.Count} ({sw.Elapsed.TotalSeconds:F1}s)");

        var monsters = provider.LoadPackageObject<UDataTable>("Pal/Content/Pal/DataTable/Character/DT_PalMonsterParameter");
        var skillNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_SkillNameText_Common");
        var skillDescs = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_SkillDescText_Common");
        var palNames = LoadText(provider, "Pal/Content/L10N/en/Pal/DataTable/Text/DT_PalNameText_Common");
        Console.WriteLine($"[tables] monsters={monsters.RowMap.Count} skillNames={skillNames.Count} skillDescs={skillDescs.Count}");

        var species = new SortedDictionary<string, object>(StringComparer.Ordinal);
        int kept = 0, skipped = 0;
        int partnerHit = 0;
        var partnerMisses = new List<string>();
        var elementKinds = new SortedSet<string>(StringComparer.Ordinal);
        // internalName -> english display, for validation only
        var displayByInternal = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in palNames)
            if (kv.Key.StartsWith("PAL_NAME_", StringComparison.OrdinalIgnoreCase))
                displayByInternal[kv.Key.Substring("PAL_NAME_".Length)] = kv.Value;

        foreach (var r in monsters.RowMap)
        {
            var name = r.Key.Text;
            var v = Vals(r.Value);
            bool playable = B(v, "IsPal") && !(B(v, "IsBoss") || B(v, "IsTowerBoss") || B(v, "IsRaidBoss"))
                && !name.StartsWith("SUMMON_", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("BOSS_", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("GYM_", StringComparison.OrdinalIgnoreCase)
                && !name.StartsWith("RAID_", StringComparison.OrdinalIgnoreCase)
                && !name.Contains("PREDATOR", StringComparison.OrdinalIgnoreCase)
                && !name.EndsWith("_Oilrig", StringComparison.OrdinalIgnoreCase)
                && !name.Contains("Quest", StringComparison.OrdinalIgnoreCase)
                && I(v, "Rarity") > 0 && I(v, "WalkSpeed") > 0 && I(v, "RunSpeed") > 0;
            if (!playable) { skipped++; continue; }
            kept++;

            var elements = new List<string>();
            foreach (var ek in new[] { "ElementType1", "ElementType2" })
            {
                var e = StripEnum(S(v, ek));
                if (!string.IsNullOrEmpty(e) && e != "None") { elements.Add(e); elementKinds.Add(e); }
            }

            // partner skill: override key, else PARTNERSKILL_<InternalName>, else strip variant suffix (_Ice/_Fire/_Flower/...) to the base species key
            var nameKey = ResolvePartnerKey(skillNames, NonNone(S(v, "OverridePartnerSkillNameTextID")), name);
            var descKey = ResolvePartnerKey(skillDescs, NonNone(S(v, "OverridePartnerSkillDescTextID")), name);
            object partner = null;
            if (nameKey != null && skillNames.TryGetValue(nameKey, out var pName))
            {
                partnerHit++;
                string pDesc = descKey != null && skillDescs.TryGetValue(descKey, out var d) ? d : null;
                partner = new { name = Clean(pName), description = pDesc == null ? null : Clean(pDesc) };
            }
            else partnerMisses.Add($"{name}");

            var stats = new
            {
                price = (long)Math.Round(F(v, "Price")),
                craft_speed = I(v, "CraftSpeed"),
                slow_walk_speed = I(v, "SlowWalkSpeed"),
                walk_speed = I(v, "WalkSpeed"),
                run_speed = I(v, "RunSpeed"),
                ride_sprint_speed = I(v, "RideSprintSpeed"),
                transport_speed = I(v, "TransportSpeed"),
                stamina = I(v, "Stamina"),
                size = StripEnum(S(v, "Size")),
                food_amount = I(v, "FoodAmount"),
                max_full_stomach = I(v, "MaxFullStomach"),
                rarity = I(v, "Rarity"),
                male_probability = I(v, "MaleProbability"),
                combi_rank = I(v, "CombiRank"),
                nocturnal = B(v, "Nocturnal"),
            };

            species[name] = new { elements, partner_skill = partner, stats };
        }
        Console.WriteLine($"[species] kept={kept} skipped={skipped} partnerCoverage={partnerHit}/{kept}");
        Console.WriteLine($"[elements] distinct=[{string.Join(",", elementKinds)}]");
        if (partnerMisses.Count > 0)
            Console.WriteLine($"[partner misses {partnerMisses.Count}] {string.Join(" | ", partnerMisses)}");

        // ---- game settings CDO ----
        var gameSettings = ReadGameSettings(provider);

        // ---- element icons ----
        var iconVariants = ExportElementIcons(provider);

        // ---- assemble + write ----
        var root = new
        {
            meta = new
            {
                game_build = GameBuild,
                extracted_at = DateTimeOffset.UtcNow.ToString("o"),
                usmap = UsmapSource,
            },
            game_settings = gameSettings,
            species,
        };
        Directory.CreateDirectory(OutDir);
        var outPath = Path.Combine(OutDir, "extracted-game-data.json");
        File.WriteAllText(outPath, JsonConvert.SerializeObject(root, Formatting.Indented));
        Console.WriteLine($"[write] {outPath}");

        // ---- validation gates ----
        var errors = new List<string>();
        void Gate(bool ok, string msg) { if (!ok) errors.Add(msg); }

        Gate(kept >= 299, $"species count {kept} < 299");

        string LamballKey = displayByInternal.FirstOrDefault(kv => string.Equals(kv.Value, "Lamball", StringComparison.OrdinalIgnoreCase)).Key ?? "SheepBall";
        string JormKey = displayByInternal.FirstOrDefault(kv => string.Equals(kv.Value, "Jormuntide", StringComparison.OrdinalIgnoreCase)).Key ?? "Umihebi";

        var lamball = species.TryGetValue(LamballKey, out var lo) ? lo : null;
        Gate(lamball != null, $"Lamball ({LamballKey}) not in species");
        string lamballPartner = lamball == null ? null : (string)GetProp(GetProp(lamball, "partner_skill"), "name");
        Gate(lamballPartner == "Fluffy Shield", $"Lamball partner name '{lamballPartner}' != 'Fluffy Shield'");

        var jorm = species.TryGetValue(JormKey, out var jo) ? jo : null;
        Gate(jorm != null, $"Jormuntide ({JormKey}) not in species");
        var jormElems = jorm == null ? new List<string>() : (List<string>)GetProp(jorm, "elements");
        Gate(jormElems.SequenceEqual(new[] { "Dragon", "Water" }), $"Jormuntide elements [{string.Join(",", jormElems)}] != [Dragon,Water]");

        Gate(((System.Collections.IEnumerable)(((IDictionary<string, object>)gameSettings)["combi_talent_inherit_num"])).Cast<object>().Any(), "Combi_TalentInheritNum empty");
        Gate(((System.Collections.IEnumerable)(((IDictionary<string, object>)gameSettings)["combi_passive_inherit_num"])).Cast<object>().Any(), "Combi_PassiveInheritNum empty");
        Gate(((System.Collections.IEnumerable)(((IDictionary<string, object>)gameSettings)["combi_passive_random_add_num"])).Cast<object>().Any(), "Combi_PassiveRandomAddNum empty");

        foreach (var kv in species)
        {
            var el = (List<string>)GetProp(kv.Value, "elements");
            if (el.Count < 1 || el.Count > 2) { Gate(false, $"{kv.Key} has {el.Count} elements"); break; }
        }
        Gate(partnerHit == kept, $"partner coverage {partnerHit}/{kept}");

        // ---- summary ----
        Console.WriteLine("==== SUMMARY ====");
        Console.WriteLine($"species kept={kept} skipped={skipped}");
        Console.WriteLine($"partner-skill coverage={partnerHit}/{kept}");
        var gs = (IDictionary<string, object>)gameSettings;
        Console.WriteLine($"combi_talent_inherit_num       = [{string.Join(", ", ((IEnumerable<object>)gs["combi_talent_inherit_num"]))}]");
        Console.WriteLine($"combi_passive_inherit_num      = [{string.Join(", ", ((IEnumerable<object>)gs["combi_passive_inherit_num"]))}]");
        Console.WriteLine($"combi_passive_random_add_num   = [{string.Join(", ", ((IEnumerable<object>)gs["combi_passive_random_add_num"]))}]");
        Console.WriteLine($"other game_settings keys=[{string.Join(",", gs.Keys)}]");
        Console.WriteLine($"element icon variants exported: {string.Join(", ", iconVariants)}");
        if (lamball != null)
        {
            Console.WriteLine($"Lamball({LamballKey}) partner={lamballPartner}");
            Console.WriteLine("Lamball stats: " + JsonConvert.SerializeObject(GetProp(lamball, "stats")));
            Console.WriteLine("Lamball elements: " + JsonConvert.SerializeObject(GetProp(lamball, "elements")));
        }
        Console.WriteLine($"wall time: {sw.Elapsed.TotalSeconds:F1}s");

        if (errors.Count > 0)
        {
            Console.WriteLine("==== VALIDATION FAILED ====");
            foreach (var e in errors) Console.WriteLine("  FAIL: " + e);
            return 1;
        }
        Console.WriteLine("==== ALL GATES PASSED ====");
        return 0;
    }

    static IDictionary<string, object> ReadGameSettings(IFileProvider provider)
    {
        var res = new Dictionary<string, object>();
        if (!provider.TryLoadPackage("Pal/Content/Pal/Blueprint/System/BP_PalGameSetting", out var pkg))
        {
            Console.WriteLine("[gamesetting] FAILED to load package");
            return res;
        }
        var cdo = pkg.GetExports().FirstOrDefault(e => e.Name.StartsWith("Default__"));
        if (cdo == null) { Console.WriteLine("[gamesetting] no CDO export"); return res; }

        // canonical breeding arrays first (deterministic order)
        AddArray(res, cdo, "Combi_TalentInheritNum", "combi_talent_inherit_num");
        AddArray(res, cdo, "Combi_PassiveInheritNum", "combi_passive_inherit_num");
        AddArray(res, cdo, "Combi_PassiveRandomAddNum", "combi_passive_random_add_num");

        // any other Combi/Talent/Passive/Breed/Inherit scalar or scalar-array props
        foreach (var p in cdo.Properties.OrderBy(p => p.Name.Text, StringComparer.Ordinal))
        {
            var n = p.Name.Text;
            if (!(n.Contains("Combi") || n.Contains("Talent") || n.Contains("Passive") || n.Contains("Breed") || n.Contains("Inherit"))) continue;
            var key = ToSnake(n);
            if (res.ContainsKey(key)) continue;
            var val = p.Tag?.GenericValue;
            if (val is UScriptArray arr)
            {
                var list = arr.Properties.Select(x => Num(x.GenericValue)).Where(x => x != null).ToList();
                if (list.Count == arr.Properties.Count && list.Count > 0) res[key] = list;
            }
            else
            {
                var num = Num(val);
                if (num != null) res[key] = num;
                else if (val is bool bb) res[key] = bb;
            }
        }
        return res;
    }

    static void AddArray(Dictionary<string, object> res, dynamic cdo, string prop, string key)
    {
        var tag = ((IEnumerable<FPropertyTag>)cdo.Properties).FirstOrDefault(p => p.Name.Text == prop);
        if (tag?.Tag?.GenericValue is UScriptArray arr)
            res[key] = arr.Properties.Select(x => Num(x.GenericValue)).ToList();
        else
            res[key] = new List<object>();
    }

    static List<string> ExportElementIcons(IFileProvider provider)
    {
        var elDir = Path.Combine(OutDir, "icons", "elements");
        Directory.CreateDirectory(elDir);
        var variants = new List<string>();

        int tiles = ExportSet(provider, "Pal/Content/Pal/Texture/UI/InGame/T_Icon_element_s_", elDir, "tile");
        if (tiles > 0) variants.Add($"tile({tiles})");
        int glyphs = ExportSet(provider, "Pal/Content/Pal/Texture/UI/Main_Menu/T_Icon_element_", elDir, "glyph");
        if (glyphs > 0) variants.Add($"glyph({glyphs})");
        return variants;
    }

    static int ExportSet(IFileProvider provider, string basePath, string outDir, string suffix)
    {
        int count = 0;
        for (int i = 0; i < IconKinds.Length; i++)
        {
            var assetPath = $"{basePath}{i:00}";
            try
            {
                if (!provider.TryLoadPackageObject(assetPath, out var obj) || obj is not UTexture2D tex) continue;
                using var bmp = tex.Decode(ETexturePlatform.DesktopMobile)?.ToSkBitmap();
                if (bmp == null) continue;
                using var data = bmp.Encode(SKEncodedImageFormat.Png, 100);
                var outPath = Path.Combine(outDir, $"{IconKinds[i]}_{suffix}.png");
                using var fs = File.Create(outPath);
                data.SaveTo(fs);
                count++;
            }
            catch (Exception e) { Console.WriteLine($"[icon] {assetPath} fail: {e.Message}"); }
        }
        return count;
    }

    // ---- helpers ----
    static Dictionary<string, object> Vals(FStructFallback s)
    {
        var d = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in s.Properties) d[p.Name.Text] = p.Tag?.GenericValue;
        return d;
    }
    static bool B(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o is bool b && b;
    static int I(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o != null ? Convert.ToInt32(o) : 0;
    static double F(Dictionary<string, object> v, string k) => v.TryGetValue(k, out var o) && o != null ? Convert.ToDouble(o) : 0;
    static string S(Dictionary<string, object> v, string k)
    {
        if (!v.TryGetValue(k, out var o) || o == null) return null;
        return o is FName fn ? fn.Text : o.ToString();
    }
    static string StripEnum(string s) => s == null ? null : (s.Contains("::") ? s.Substring(s.IndexOf("::") + 2) : s);
    static string NonNone(string s) => string.IsNullOrEmpty(s) || s == "None" ? null : s;
    static string ResolvePartnerKey(Dictionary<string, string> table, string overrideKey, string internalName)
    {
        if (overrideKey != null && table.ContainsKey(overrideKey)) return overrideKey;
        var n = internalName;
        while (true)
        {
            var k = "PARTNERSKILL_" + n;
            if (table.ContainsKey(k)) return k;
            var idx = n.LastIndexOf('_');
            if (idx < 0) return null;
            n = n.Substring(0, idx);
        }
    }
    static object Num(object v) => v switch
    {
        null => null,
        int i => i,
        long l => l,
        short sh => (int)sh,
        byte b => (int)b,
        uint u => (long)u,
        float f => IntOrRound(f),
        double d => IntOrRound(d),
        _ => null,
    };
    static object IntOrRound(double d) => d == Math.Floor(d) && Math.Abs(d) < 9.2e18 ? (object)(long)d : Math.Round(d, 5);
    static string ToSnake(string s)
    {
        var t = Regex.Replace(s, "([a-z0-9])([A-Z])", "$1_$2").Replace("__", "_");
        return t.ToLowerInvariant();
    }
    static string Clean(string s)
    {
        if (s == null) return null;
        s = s.Replace("\r\n", "\n").Replace("\r", "\n");
        s = RichTag.Replace(s, "");
        s = Ws.Replace(s, " ");
        return s.Trim();
    }

    static Dictionary<string, string> LoadText(IFileProvider p, string path)
    {
        var t = p.LoadPackageObject<UDataTable>(path);
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in t.RowMap)
            d[e.Key.Text] = e.Value.Get<FText>("TextData").Text;
        return d;
    }

    // read a property off an anonymous object (validation convenience)
    static object GetProp(object o, string name) => o?.GetType().GetProperty(name)?.GetValue(o);
}
