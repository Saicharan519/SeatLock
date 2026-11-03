import { ButtonLink } from '../components/ui';
import { useTitle } from '../lib/hooks';

export function NotFound() {
  useTitle('Page not found');
  return (
    <div className="mx-auto max-w-3xl px-4 pt-24 text-center">
      <div className="font-display text-[10rem] leading-none font-black text-marigold/80">404</div>
      <h1 className="font-display mt-2 text-4xl font-black tracking-wide uppercase">
        Wrong screen
      </h1>
      <p className="mt-3 text-dim">
        This page doesn’t exist. The film you’re after is probably on another screen.
      </p>
      <ButtonLink to="/" className="mt-8">
        Back to the lobby
      </ButtonLink>
    </div>
  );
}
