import { AdminClientDetailView } from './client-view';

/*
 * One client, from `GET /admin/clients/:id` plus that client's usage, keys,
 * subscriptions and payments.
 *
 * `params` is a promise in Next 15. The id is read here and handed to the client
 * view as a plain prop, so the view stays an ordinary fetch-on-mount component
 * like the rest of this panel.
 */
export default async function AdminClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminClientDetailView id={id} />;
}
