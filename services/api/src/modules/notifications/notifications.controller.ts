import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { sessionOf } from '../../platform/http.js';
import { SessionGuard } from '../identity/guards.js';
import { type NotificationView, NotificationsService } from './notifications.service.js';

// Kept apart from the service so that modules which only send notifications
// do not also import the guards (and, through them, the identity module).
@Controller('v1/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  /** What AORA has sent the signed-in person, and what became of it. */
  @Get()
  async list(@Req() request: Request): Promise<{ data: NotificationView[] }> {
    return { data: await this.notifications.listFor(sessionOf(request).accountId) };
  }
}
