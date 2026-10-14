import { AdminSubscriptionDetailView } from './subscription-view';

/*
 * One subscription and its whole money trail, from `GET /admin/subscriptions/:id`.
 *
 * `params` is a promise in Next 15. The id is read here and handed to the client
 * view as a plain prop, so the view stays an ordinary fetch-on-mount component
 * like the rest of this panel.
 */
export default async function AdminSubscriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AdminSubscriptionDetailView id={id} />;
}
