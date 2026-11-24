import type { TaskStore } from '../../evidence.js';
import { type TicketProjection } from './lifecycle.js';
export declare const ValidateTicketTransition: (from: TicketProjection, to: TicketProjection) => void;
export interface TicketRepository extends TaskStore {
    projection: (taskId: string) => TicketProjection | undefined;
    projectionAll: () => TicketProjection[];
}
/** TaskStore adapter enforcing Ticket lifecycle and Assignment revision boundaries. */
export declare const intTicketRepository: (store: TaskStore) => TicketRepository;
