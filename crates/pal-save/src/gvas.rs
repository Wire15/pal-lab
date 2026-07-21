//! GVAS header + UE property-tree decoding. This is a *selective* reader: it
//! fully materializes property subtrees we ask for and structurally skips the
//! rest by their serialized size, so a 30 MB `Level.sav` need not be fully
//! deserialized. Property encoding follows cheahjs/palworld-save-tools
//! `gvas.py`/`archive.py`.

use pal_data::types::Guid;

use crate::archive::Reader;
use crate::SaveError;

/// GVAS file magic, `"GVAS"` little-endian.
pub const GVAS_MAGIC: i32 = 0x5341_5647;

/// An ordered property set (`properties_until_end`), preserving save order.
pub type Props = Vec<(String, Value)>;

/// Look up a property by name within a property set.
pub fn find<'a>(props: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    props.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// A decoded UE property value. Only the shapes that occur in the subtrees we
/// materialize are represented; everything else is skipped upstream.
#[derive(Debug, Clone)]
pub enum Value {
    Int(i32),
    Int64(i64),
    UInt32(u32),
    UInt16(u16),
    Float(f32),
    Double(f64),
    Bool(bool),
    Str(String),
    /// `NameProperty` / `EnumProperty` values, and `ByteProperty` enum labels.
    Name(String),
    /// `StructProperty` whose body is a nested property set.
    Props(Props),
    /// `StructProperty` scalar of type `Guid`.
    Guid(Guid),
    /// `StructProperty` scalar we don't decode (Vector/Quat/DateTime/...).
    OpaqueStruct,
    /// Array of nested property sets / scalars (`ArrayProperty`).
    Array(Vec<Value>),
    /// Raw bytes of a `ByteProperty` array (e.g. `RawData`).
    Bytes(Vec<u8>),
}

impl Value {
    pub fn as_i32(&self) -> Option<i32> {
        match self {
            Value::Int(v) => Some(*v),
            Value::Int64(v) => Some(*v as i32),
            Value::UInt32(v) => Some(*v as i32),
            Value::UInt16(v) => Some(*v as i32),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(v) => Some(*v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) | Value::Name(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_props(&self) -> Option<&Props> {
        match self {
            Value::Props(p) => Some(p),
            _ => None,
        }
    }
    pub fn as_guid(&self) -> Option<Guid> {
        match self {
            Value::Guid(g) => Some(*g),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }
}

/// GVAS file header. We validate the magic + save-game version and otherwise
/// consume the header to position the reader at the first property.
pub struct GvasHeader {
    pub save_game_version: i32,
    pub save_game_class_name: String,
}

impl GvasHeader {
    pub fn read(r: &mut Reader) -> Result<GvasHeader, SaveError> {
        let magic = r.i32()?;
        if magic != GVAS_MAGIC {
            return Err(SaveError::Gvas(format!(
                "bad GVAS magic 0x{magic:08x}, expected 0x{GVAS_MAGIC:08x}"
            )));
        }
        let save_game_version = r.i32()?;
        if save_game_version != 3 {
            return Err(SaveError::Gvas(format!(
                "unexpected save game version {save_game_version}, expected 3"
            )));
        }
        // PackageFileUEVersion (ue4, ue5)
        r.i32()?;
        r.i32()?;
        // SavedEngineVersion: major/minor/patch (u16) + changelist (u32) + branch
        r.u16()?;
        r.u16()?;
        r.u16()?;
        r.u32()?;
        let _branch = r.fstring()?;
        // CustomVersionFormat + custom versions (guid + i32 pairs)
        let custom_version_format = r.i32()?;
        if custom_version_format != 3 {
            return Err(SaveError::Gvas(format!(
                "unexpected custom version format {custom_version_format}, expected 3"
            )));
        }
        let count = r.u32()?;
        for _ in 0..count {
            r.skip(16)?; // guid
            r.i32()?; // version
        }
        let save_game_class_name = r.fstring()?;
        Ok(GvasHeader {
            save_game_version,
            save_game_class_name,
        })
    }
}

/// Read `properties_until_end`: a sequence of `name/type/size` tagged
/// properties terminated by a property named `"None"`. Every property is fully
/// materialized. Use this only for regions known to be small (map keys/values,
/// character RawData, player saves) — for large containers, parse selectively
/// with [`read_tag`]/[`skip_property`].
pub fn read_properties_until_end(r: &mut Reader) -> Result<Props, SaveError> {
    let mut props = Props::new();
    loop {
        let name = r.fstring()?;
        if name == "None" {
            break;
        }
        let type_name = r.fstring()?;
        let size = r.u64()? as usize;
        let value = read_property(r, &type_name, size)?;
        props.push((name, value));
    }
    Ok(props)
}

/// A single property tag: `(name, type_name, size)`. Returns `None` when the
/// terminating `"None"` marker is hit.
pub fn read_tag(r: &mut Reader) -> Result<Option<(String, String, usize)>, SaveError> {
    let name = r.fstring()?;
    if name == "None" {
        return Ok(None);
    }
    let type_name = r.fstring()?;
    let size = r.u64()? as usize;
    Ok(Some((name, type_name, size)))
}

/// Fully decode one property value given its `type_name` and serialized `size`.
pub fn read_property(r: &mut Reader, type_name: &str, size: usize) -> Result<Value, SaveError> {
    Ok(match type_name {
        "IntProperty" => {
            r.optional_guid()?;
            Value::Int(r.i32()?)
        }
        "Int64Property" => {
            r.optional_guid()?;
            Value::Int64(r.i64()?)
        }
        "UInt32Property" => {
            r.optional_guid()?;
            Value::UInt32(r.u32()?)
        }
        "UInt16Property" => {
            r.optional_guid()?;
            Value::UInt16(r.u16()?)
        }
        "FloatProperty" => {
            r.optional_guid()?;
            Value::Float(r.f32()?)
        }
        "DoubleProperty" => {
            r.optional_guid()?;
            Value::Double(r.f64()?)
        }
        "BoolProperty" => {
            let v = r.bool()?;
            r.optional_guid()?;
            Value::Bool(v)
        }
        "StrProperty" => {
            r.optional_guid()?;
            Value::Str(r.fstring()?)
        }
        "NameProperty" => {
            r.optional_guid()?;
            Value::Name(r.fstring()?)
        }
        "EnumProperty" => {
            let _enum_type = r.fstring()?;
            r.optional_guid()?;
            Value::Name(r.fstring()?)
        }
        "ByteProperty" => {
            let enum_type = r.fstring()?;
            r.optional_guid()?;
            if enum_type == "None" {
                Value::UInt16(r.u8()? as u16)
            } else {
                Value::Name(r.fstring()?)
            }
        }
        "StructProperty" => {
            let struct_type = r.fstring()?;
            r.skip(16)?; // struct_id
            r.optional_guid()?;
            read_struct_value(r, &struct_type)?
        }
        "ArrayProperty" => {
            let array_type = r.fstring()?;
            r.optional_guid()?;
            read_array(r, &array_type, size)?
        }
        "MapProperty" => {
            // Not needed inside materialized subtrees; skip the value region.
            let _key_type = r.fstring()?;
            let _value_type = r.fstring()?;
            r.optional_guid()?;
            r.skip(size)?;
            Value::OpaqueStruct
        }
        other => {
            return Err(SaveError::Gvas(format!(
                "unsupported property type {other:?} (size {size})"
            )));
        }
    })
}

/// Decode a `StructProperty` body given its struct type. Scalar struct types
/// have fixed layouts; everything else is a nested property set.
fn read_struct_value(r: &mut Reader, struct_type: &str) -> Result<Value, SaveError> {
    Ok(match struct_type {
        "Guid" => Value::Guid(r.guid()?),
        "DateTime" => {
            r.u64()?;
            Value::OpaqueStruct
        }
        "Vector" => {
            r.skip(24)?; // 3 x f64
            Value::OpaqueStruct
        }
        "Quat" => {
            r.skip(32)?; // 4 x f64
            Value::OpaqueStruct
        }
        "LinearColor" => {
            r.skip(16)?; // 4 x f32
            Value::OpaqueStruct
        }
        _ => Value::Props(read_properties_until_end(r)?),
    })
}

/// Decode an `ArrayProperty` value region (`count` prefix + elements).
fn read_array(r: &mut Reader, array_type: &str, size: usize) -> Result<Value, SaveError> {
    let count = r.u32()? as usize;
    match array_type {
        "ByteProperty" => {
            // The size covers the u32 count + the raw bytes; the byte payload is
            // whatever remains. Fall back to `count` bytes if the arithmetic is
            // off (labelled byte arrays are not used by Palworld saves).
            let n = size.checked_sub(4).unwrap_or(count).min(r.remaining());
            let n = if n >= count { count } else { n };
            Ok(Value::Bytes(r.bytes(n)?.to_vec()))
        }
        "NameProperty" | "EnumProperty" | "StrProperty" => {
            let mut out = Vec::with_capacity(count);
            for _ in 0..count {
                out.push(Value::Name(r.fstring()?));
            }
            Ok(Value::Array(out))
        }
        "Guid" => {
            let mut out = Vec::with_capacity(count);
            for _ in 0..count {
                out.push(Value::Guid(r.guid()?));
            }
            Ok(Value::Array(out))
        }
        "IntProperty" => {
            let mut out = Vec::with_capacity(count);
            for _ in 0..count {
                out.push(Value::Int(r.i32()?));
            }
            Ok(Value::Array(out))
        }
        "StructProperty" => {
            // Struct array header, then `count` bare struct values.
            let _prop_name = r.fstring()?;
            let _prop_type = r.fstring()?;
            r.u64()?; // element region size
            let elem_type = r.fstring()?;
            r.skip(16)?; // struct id
            r.skip(1)?; // optional-guid flag (always 0 here)
            let mut out = Vec::with_capacity(count);
            for _ in 0..count {
                out.push(read_struct_value(r, &elem_type)?);
            }
            Ok(Value::Array(out))
        }
        other => Err(SaveError::Gvas(format!(
            "unsupported array element type {other:?}"
        ))),
    }
}

/// Structurally skip a property's value (and its type-specific inline header),
/// given the tag already read. Used to bypass containers we don't materialize.
pub fn skip_property(r: &mut Reader, type_name: &str, size: usize) -> Result<(), SaveError> {
    match type_name {
        "StructProperty" => {
            r.fstring()?; // struct_type
            r.skip(16)?; // struct_id
            r.optional_guid()?;
            r.skip(size)?;
        }
        "ArrayProperty" | "SetProperty" => {
            r.fstring()?; // element type
            r.optional_guid()?;
            r.skip(size)?;
        }
        "MapProperty" => {
            r.fstring()?; // key_type
            r.fstring()?; // value_type
            r.optional_guid()?;
            r.skip(size)?;
        }
        "EnumProperty" | "ByteProperty" => {
            r.fstring()?; // enum type
            r.optional_guid()?;
            r.skip(size)?;
        }
        "BoolProperty" => {
            r.u8()?; // value
            r.optional_guid()?;
            r.skip(size)?; // size == 0
        }
        "IntProperty" | "Int64Property" | "UInt32Property" | "UInt16Property"
        | "FloatProperty" | "DoubleProperty" | "StrProperty" | "NameProperty" => {
            r.optional_guid()?;
            r.skip(size)?;
        }
        other => {
            return Err(SaveError::Gvas(format!(
                "cannot skip unknown property type {other:?}"
            )));
        }
    }
    Ok(())
}
