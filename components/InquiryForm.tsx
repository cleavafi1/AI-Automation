"use client";

import { useState } from "react";

type FormState = {
  name: string;
  email: string;
  phone: string;
  raw_request: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  email: "",
  phone: "",
  raw_request: "",
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

// Mirror of the server-side rules for fast client feedback.
// The server remains the source of truth.
function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "Anna nimesi.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    errors.email = "Anna kelvollinen sähköpostiosoite.";
  if (!form.phone.trim()) errors.phone = "Anna puhelinnumerosi.";
  if (!form.raw_request.trim())
    errors.raw_request = "Kerro lyhyesti mitä toivot.";
  return errors;
}

export default function InquiryForm() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const clientErrors = validate(form);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (res.status === 400 && data?.fieldErrors) {
          setErrors(data.fieldErrors as FieldErrors);
        } else {
          setSubmitError(
            "Jotain meni pieleen. Yritä hetken kuluttua uudelleen."
          );
        }
        return;
      }

      setSuccess(true);
      setForm(EMPTY_FORM);
    } catch {
      setSubmitError("Jotain meni pieleen. Yritä hetken kuluttua uudelleen.");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
        <h2 className="text-lg font-semibold text-green-800">
          Kiitos! Otamme yhteyttä 24 tunnin sisällä.
        </h2>
        <button
          type="button"
          onClick={() => setSuccess(false)}
          className="mt-4 text-sm font-medium text-green-700 underline underline-offset-2 hover:text-green-900"
        >
          Lähetä uusi pyyntö
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <Field label="Nimi" htmlFor="name" error={errors.name}>
        <input
          id="name"
          type="text"
          autoComplete="name"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          className={inputClass(!!errors.name)}
        />
      </Field>

      <Field label="Sähköposti" htmlFor="email" error={errors.email}>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => update("email", e.target.value)}
          className={inputClass(!!errors.email)}
        />
      </Field>

      <Field label="Puhelinnumero" htmlFor="phone" error={errors.phone}>
        <input
          id="phone"
          type="tel"
          autoComplete="tel"
          value={form.phone}
          onChange={(e) => update("phone", e.target.value)}
          placeholder="+358 40 123 4567"
          className={inputClass(!!errors.phone)}
        />
      </Field>

      <Field
        label="Kerro lyhyesti mitä toivot"
        htmlFor="raw_request"
        error={errors.raw_request}
      >
        <textarea
          id="raw_request"
          rows={5}
          value={form.raw_request}
          onChange={(e) => update("raw_request", e.target.value)}
          placeholder="esim. asunnon koko, palvelu, ajankohta."
          className={inputClass(!!errors.raw_request)}
        />
      </Field>

      {submitError && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? "Lähetetään…" : "Lähetä pyyntö"}
      </button>
    </form>
  );
}

function inputClass(invalid: boolean) {
  return [
    "w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition",
    "placeholder:text-slate-400 focus:ring-2 focus:ring-offset-0",
    invalid
      ? "border-red-400 focus:border-red-500 focus:ring-red-200"
      : "border-slate-300 focus:border-slate-500 focus:ring-slate-200",
  ].join(" ");
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-sm font-medium text-slate-700"
      >
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
