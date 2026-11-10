import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Poster } from '../../components/Poster';
import { Button, Notice, Skeleton } from '../../components/ui';
import { api, type MovieDetail, type MovieInput } from '../../lib/api';
import { useTitle } from '../../lib/hooks';
import { Field, Input, PageHeader, Panel, Select, TextArea } from './kit';

/** The form keeps everything as text; it becomes a MovieInput only on save. */
interface Draft {
  title: string;
  synopsis: string;
  genres: string;
  language: string;
  durationMinutes: string;
  certificate: 'U' | 'UA' | 'A';
  rating: string;
  director: string;
  cast: string;
  posterUrl: string;
  backdropUrl: string;
  releaseDate: string;
}

const EMPTY: Draft = {
  title: '',
  synopsis: '',
  genres: '',
  language: 'English',
  durationMinutes: '',
  certificate: 'UA',
  rating: '',
  director: '',
  cast: '',
  posterUrl: '',
  backdropUrl: '',
  releaseDate: '',
};

const fromMovie = (m: MovieDetail): Draft => ({
  title: m.title,
  synopsis: m.synopsis,
  genres: m.genres.join(', '),
  language: m.language,
  durationMinutes: String(m.durationMinutes),
  certificate: m.certificate,
  rating: m.rating === null ? '' : String(m.rating),
  director: m.director,
  cast: m.cast.join(', '),
  posterUrl: m.posterUrl ?? '',
  backdropUrl: m.backdropUrl ?? '',
  releaseDate: m.releaseDate,
});

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const toInput = (d: Draft): MovieInput => ({
  title: d.title.trim(),
  synopsis: d.synopsis.trim(),
  genres: list(d.genres),
  language: d.language.trim(),
  durationMinutes: Number(d.durationMinutes),
  certificate: d.certificate,
  rating: d.rating.trim() === '' ? null : Number(d.rating),
  director: d.director.trim(),
  cast: list(d.cast),
  posterUrl: d.posterUrl.trim() || null,
  backdropUrl: d.backdropUrl.trim() || null,
  releaseDate: d.releaseDate,
});

/** Add a movie (/admin/movies/new) or edit one (/admin/movies/:id). */
export function MovieForm() {
  const { id } = useParams();
  const editing = id !== undefined;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useTitle(editing ? 'Edit movie · Admin' : 'Add movie · Admin');

  useEffect(() => {
    if (!id) return;
    api
      .movie(id)
      .then(({ movie }) => {
        setDraft(fromMovie(movie));
        setSlug(movie.slug);
        setLoaded(true);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [id]);

  const set = (key: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = toInput(draft);
      if (editing) await api.admin.updateMovie(id, input);
      else await api.admin.createMovie(input);
      navigate('/admin/movies', { state: { saved: input.title } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!loaded) return <Skeleton className="h-96" />;

  return (
    <>
      <PageHeader title={editing ? 'Edit movie' : 'Add movie'}>
        {editing ? (
          <>
            The web address stays <span className="font-mono">/movies/{slug}</span>: people may have
            shared it. Shows already scheduled keep their times if you change the running time.
          </>
        ) : (
          'The web address is made from the title. Amounts and times come later, per show.'
        )}
      </PageHeader>
      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_220px]">
        <Panel>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" className="sm:col-span-2">
              <Input required maxLength={200} value={draft.title} onChange={set('title')} />
            </Field>
            <Field label="Synopsis" className="sm:col-span-2">
              <TextArea
                rows={4}
                maxLength={4000}
                value={draft.synopsis}
                onChange={set('synopsis')}
              />
            </Field>
            <Field label="Genres" hint="Comma-separated, e.g. Drama, Thriller">
              <Input value={draft.genres} onChange={set('genres')} />
            </Field>
            <Field label="Language">
              <Input required maxLength={40} value={draft.language} onChange={set('language')} />
            </Field>
            <Field label="Running time (minutes)">
              <Input
                required
                type="number"
                min={1}
                max={600}
                value={draft.durationMinutes}
                onChange={set('durationMinutes')}
              />
            </Field>
            <Field label="Certificate">
              <Select value={draft.certificate} onChange={set('certificate')}>
                <option value="U">U</option>
                <option value="UA">U/A</option>
                <option value="A">A</option>
              </Select>
            </Field>
            <Field label="Rating (0 to 10)" hint="Leave empty for no rating">
              <Input
                type="number"
                min={0}
                max={10}
                step={0.1}
                value={draft.rating}
                onChange={set('rating')}
              />
            </Field>
            <Field label="Release date">
              <Input required type="date" value={draft.releaseDate} onChange={set('releaseDate')} />
            </Field>
            <Field label="Director">
              <Input maxLength={200} value={draft.director} onChange={set('director')} />
            </Field>
            <Field label="Cast" hint="Comma-separated">
              <Input value={draft.cast} onChange={set('cast')} />
            </Field>
            <Field label="Poster image URL" className="sm:col-span-2">
              <Input type="url" value={draft.posterUrl} onChange={set('posterUrl')} />
            </Field>
            <Field label="Backdrop image URL" className="sm:col-span-2">
              <Input type="url" value={draft.backdropUrl} onChange={set('backdropUrl')} />
            </Field>
          </div>
          {error && (
            <Notice tone="error" className="mt-5">
              {error}
            </Notice>
          )}
          <div className="mt-6 flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add movie'}
            </Button>
            <Link to="/admin/movies" className="text-sm font-semibold text-dim hover:text-screen">
              Cancel
            </Link>
          </div>
        </Panel>
        <div>
          <div className="mb-2 font-mono text-[11px] tracking-[0.18em] text-faint uppercase">
            Poster preview
          </div>
          <Poster
            key={draft.posterUrl}
            eager
            url={draft.posterUrl.trim() || null}
            title={draft.title || 'Untitled'}
          />
        </div>
      </form>
    </>
  );
}
