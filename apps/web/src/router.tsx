import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { SourcesPage } from './pages/Sources';
import { SourceDetailPage } from './pages/SourceDetail';
import { NotesPage } from './pages/Notes';
import { NoteDetailPage } from './pages/NoteDetail';
import { SearchPage } from './pages/Search';
import { ReviewPage } from './pages/Review';
import { CardsPage } from './pages/Cards';

const root = createRootRoute({
  component: Layout,
  notFoundComponent: () => <div className="text-muted">Not found.</div>,
});
const r = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => root, path, component });

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: '/', beforeLoad: () => { throw redirect({ to: '/notes' }); } }),
  r('/sources', SourcesPage),
  r('/sources/$id', SourceDetailPage),
  r('/notes', NotesPage),
  r('/notes/$id', NoteDetailPage),
  r('/search', SearchPage),
  r('/review', ReviewPage),
  r('/cards', CardsPage),
]);

export const router = createRouter({ routeTree, defaultPreload: false });
