"use client";
import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <label className="label" htmlFor="email">
          Correo
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="input"
          inputMode="email"
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input"
        />
      </div>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg mt-1" disabled={pending} type="submit">
        {pending ? "Entrando…" : "Entrar"}
      </button>
      <a href="/recuperar" className="text-center text-sm text-teal-d hover:underline">
        ¿Olvidaste tu contraseña?
      </a>
    </form>
  );
}
