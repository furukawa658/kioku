const std = @import("std");

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len != 4) return error.InvalidArguments;

    const worker_args = [_][]const u8{
        args[1],
        args[2],
        "--daemon",
    };
    var child = std.process.Child.init(&worker_args, allocator);
    child.cwd = args[3];
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    try child.spawn();
}
