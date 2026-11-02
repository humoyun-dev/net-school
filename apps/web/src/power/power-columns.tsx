import type { ReactNode } from 'react';

// Chapda forma (sidebar kabi ensiz ustun), o'ngda ro'yxat yoki tafsilot.
export function PowerColumns(props: { form: ReactNode; children: ReactNode }) {
  return (
    <div className="power-columns grid items-start gap-6 px-5 py-6 lg:grid-cols-[minmax(320px,400px)_1fr]">
      <div className="lg:sticky lg:top-[72px]">{props.form}</div>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}
