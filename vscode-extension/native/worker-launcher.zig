const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 4) return error.InvalidArguments;

    const worker_args = [_][]const u8{
        args[1],
        args[2],
        "--daemon",
    };
    _ = try std.process.spawn(init.io, .{
        .argv = &worker_args,
        .cwd = .{ .path = args[3] },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = true,
    });
}
