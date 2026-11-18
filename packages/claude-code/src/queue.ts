/** Private single-reader queue. A slow event consumer is disconnected, never the agent. */
export class Queue<T> implements AsyncIterableIterator<T> {
  private values: T[] = [];
  private ended = false;
  private error?: Error;
  private waiting?: { resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void };
  constructor(private limit: number) {}
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
  push(value: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve({ value, done: false });
    } else if (this.values.length >= this.limit) {
      this.end(new Error("Runtime event consumer fell behind"));
    } else this.values.push(value);
  }
  remove(value: T): void {
    const index = this.values.indexOf(value);
    if (index >= 0) this.values.splice(index, 1);
  }
  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    if (this.waiting) return Promise.reject(new Error("Concurrent queue reads are not supported"));
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    if (error) this.values = [];
    const waiting = this.waiting;
    this.waiting = undefined;
    if (error) waiting?.reject(error);
    else waiting?.resolve({ value: undefined, done: true });
  }
  async return(): Promise<IteratorResult<T>> {
    this.values = [];
    this.end();
    return { value: undefined, done: true };
  }
}
