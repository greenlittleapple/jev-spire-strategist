using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Godot.NativeInterop;

namespace Sts2Sim;

/// <summary>
/// Lets GodotSharp.dll run without the Godot engine.
///
/// Every call from GodotSharp into the engine goes through one table of native function pointers
/// (NativeFuncs.UnmanagedCallbacks), which the engine normally fills at startup through the public
/// NativeFuncs.Initialize. We fill that table ourselves with do-nothing functions that return zero, so engine
/// calls (printing, timers, node creation, file access) become no-ops instead of null-pointer crashes.
///
/// The combat rules never need the engine; the game itself runs them that way in its test mode. Anything that
/// did depend on an engine result would show up as a checksum mismatch against a real replay.
/// </summary>
public static unsafe class GodotHeadless
{
    public static int StubbedFunctions { get; private set; }

    public static void Install()
    {
        Type table = typeof(NativeFuncs).GetNestedType("UnmanagedCallbacks", BindingFlags.NonPublic)
            ?? throw new MissingMemberException("NativeFuncs.UnmanagedCallbacks");
        int size = SizeOf(table);
        nint* memory = (nint*)NativeMemory.AllocZeroed((nuint)size);
        foreach (FieldInfo field in table.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            int offset = (int)Marshal.OffsetOf(table, field.Name);
            memory[offset / sizeof(nint)] = field.Name switch
            {
                "godotsharp_get_class_constructor" => (nint)(delegate* unmanaged<nint>)&ReturnDummyConstructor,
                // GodotSharp refuses to run when a method or singleton lookup returns null, so these return a dummy
                // non-null handle. Nothing ever reads through it; it is only passed back into other no-op stubs.
                "godotsharp_method_bind_get_method" or "godotsharp_method_bind_get_method_with_compatibility"
                    or "godotsharp_engine_get_singleton" => (nint)(delegate* unmanaged<nint>)&ReturnDummyHandle,
                _ => StubFor(field.FieldType.GetFunctionPointerReturnType(), field.Name),
            };
            StubbedFunctions++;
        }
        NativeFuncs.Initialize((nint)memory, size);
    }

    /// <summary>
    /// Picks a stub that is correct for the Windows x64 calling convention of the given return type:
    /// integers, pointers and 1/2/4/8-byte structs come back in RAX; float and double in XMM0; any other struct is
    /// written to a caller-provided buffer whose address arrives in RCX and must be returned in RAX.
    /// </summary>
    private static nint StubFor(Type returnType, string name)
    {
        if (returnType == typeof(float) || returnType == typeof(double))
            return (nint)(delegate* unmanaged<double>)&ReturnZeroFloat;
        if (returnType == typeof(void) || returnType.IsPointer || returnType.IsFunctionPointer || returnType.IsPrimitive || returnType.IsEnum)
            return (nint)(delegate* unmanaged<nint>)&ReturnZero;
        int size = SizeOf(returnType);
        return size switch
        {
            1 or 2 or 4 or 8 => (nint)(delegate* unmanaged<nint>)&ReturnZero,
            12 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer12,
            16 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer16,
            24 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer24,
            32 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer32,
            36 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer36,
            48 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer48,
            64 => (nint)(delegate* unmanaged<byte*, byte*>)&ZeroBuffer64,
            _ => throw new NotSupportedException($"No headless stub for {name} returning {returnType.Name} ({size} bytes)."),
        };
    }

    private static int SizeOf(Type type) =>
        (int)typeof(Unsafe).GetMethod(nameof(Unsafe.SizeOf))!.MakeGenericMethod(type).Invoke(null, null)!;

    [UnmanagedCallersOnly] private static nint ReturnZero() => 0;
    [UnmanagedCallersOnly] private static double ReturnZeroFloat() => 0;
    public static readonly nint DummyHandle = (nint)NativeMemory.AllocZeroed(4096);
    [UnmanagedCallersOnly] private static nint ReturnDummyHandle() => DummyHandle;
    // The engine's "class constructor" lookup returns a constructor function; ours returns the same dummy handle.
    [UnmanagedCallersOnly] private static nint ReturnDummyConstructor() => (nint)(delegate* unmanaged<nint>)&ReturnDummyHandle;

    private static byte* Clear(byte* buffer, int size) { new Span<byte>(buffer, size).Clear(); return buffer; }
    [UnmanagedCallersOnly] private static byte* ZeroBuffer12(byte* b) => Clear(b, 12);
    [UnmanagedCallersOnly] private static byte* ZeroBuffer16(byte* b) => Clear(b, 16);
    [UnmanagedCallersOnly] private static byte* ZeroBuffer24(byte* b) => Clear(b, 24);
    [UnmanagedCallersOnly] private static byte* ZeroBuffer32(byte* b) => Clear(b, 32);
    [UnmanagedCallersOnly] private static byte* ZeroBuffer36(byte* b) => Clear(b, 36);
    [UnmanagedCallersOnly] private static byte* ZeroBuffer48(byte* b) => Clear(b, 48);
    [UnmanagedCallersOnly] private static byte* ZeroBuffer64(byte* b) => Clear(b, 64);
}
