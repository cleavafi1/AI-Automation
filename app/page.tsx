import InquiryForm from "@/components/InquiryForm";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Cleava
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">
          Pyydä tarjous siivouspalvelusta
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Täytä lomake, niin otamme sinuun yhteyttä{" "}
          <span className="font-medium text-slate-800">24 tunnin sisällä</span>.
          Palvelemme pääkaupunkiseudulla ja Jyväskylän alueella.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <InquiryForm />
      </div>

      <p className="mt-6 text-center text-xs text-slate-400">
        Mansio Group Oy · Cleava
      </p>
    </main>
  );
}
