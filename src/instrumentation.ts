/** Next.js startup hook: start the background job worker in the Node.js server runtime. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapServer } = await import("./server/bootstrap");
    bootstrapServer();
  }
}
