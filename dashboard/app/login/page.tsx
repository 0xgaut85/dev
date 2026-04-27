export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <form
        action="/api/login"
        method="post"
        className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm space-y-4"
      >
        <h1 className="text-2xl font-semibold">Crunchbase Lead Finder</h1>
        <p className="text-sm text-slate-600">Enter dashboard password.</p>
        <input
          type="password"
          name="password"
          placeholder="Password"
          required
          className="w-full border border-slate-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        {sp.error && (
          <p className="text-sm text-red-600">Incorrect password.</p>
        )}
        <button
          type="submit"
          className="w-full bg-slate-900 text-white rounded px-3 py-2 hover:bg-slate-800"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
