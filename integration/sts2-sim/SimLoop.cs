namespace Sts2Sim;

/// <summary>
/// A single-threaded loop standing in for Godot's main thread. Every await continuation in game code is posted here
/// and run in order on the calling thread, so execution is deterministic and never touches the thread pool.
/// </summary>
public sealed class SimLoop : SynchronizationContext
{
    private readonly Queue<(SendOrPostCallback, object?)> _queue = new();

    public static SimLoop Instance { get; } = new();

    public override void Post(SendOrPostCallback d, object? state) => _queue.Enqueue((d, state));

    public override void Send(SendOrPostCallback d, object? state) => d(state);

    public override SynchronizationContext CreateCopy() => this;

    /// <summary>Runs queued work until <paramref name="task"/> finishes. Throws if it stalls with nothing left to run.</summary>
    public void RunUntil(Task task, string what)
    {
        SetSynchronizationContext(this);
        while (!task.IsCompleted)
        {
            if (_queue.Count == 0)
                throw new InvalidOperationException($"Stalled: '{what}' is waiting on something that will never run headless.");
            var (callback, state) = _queue.Dequeue();
            callback(state);
        }
        task.GetAwaiter().GetResult();
    }

    public void Run(Func<Task> start, string what)
    {
        SetSynchronizationContext(this);
        RunUntil(start(), what);
    }

    /// <summary>Runs everything currently queued (and whatever that queues) until the loop is idle.</summary>
    public void Drain()
    {
        SetSynchronizationContext(this);
        while (_queue.Count > 0)
        {
            var (callback, state) = _queue.Dequeue();
            callback(state);
        }
    }

    public bool IsIdle => _queue.Count == 0;
}
