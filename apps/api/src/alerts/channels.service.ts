import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { isEmail, isURL } from 'class-validator';
import { Model } from 'mongoose';
import { isObjectId } from '../common/object-id.js';
import { AlertChannel } from '../database/schemas/alert-channel.schema.js';
import { Endpoint } from '../database/schemas/endpoint.schema.js';
import { buildTestPayload } from './alert-payload.js';
import type { CreateChannelDto } from './dto/create-channel.dto.js';
import { AlertSender } from './senders/alert-sender.js';

const MAX_CHANNELS_PER_ENDPOINT = 10;
const DUPLICATE_KEY = 11000;

@Injectable()
export class ChannelsService {
  constructor(
    @InjectModel(AlertChannel.name) private readonly channels: Model<AlertChannel>,
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
    private readonly sender: AlertSender,
  ) {}

  async create(teamId: string, endpointId: string, dto: CreateChannelDto) {
    const endpoint = await this.ownedEndpoint(teamId, endpointId);

    if (dto.type === 'EMAIL') {
      if (!isEmail(dto.target)) throw new BadRequestException('target must be a valid email address');
      if (dto.secret) throw new BadRequestException('secret only applies to webhook channels');
    } else if (!isURL(dto.target, { protocols: ['http', 'https'], require_protocol: true, require_tld: false })) {
      throw new BadRequestException('target must be a valid http(s) URL');
    }
    if ((await this.channels.countDocuments({ endpointId: endpoint._id })) >= MAX_CHANNELS_PER_ENDPOINT) {
      throw new BadRequestException(`An endpoint can have at most ${MAX_CHANNELS_PER_ENDPOINT} alert channels`);
    }

    const secret = dto.type === 'WEBHOOK' ? (dto.secret ?? `whsec_${randomBytes(24).toString('hex')}`) : null;
    try {
      const channel = await this.channels.create({
        teamId,
        endpointId: endpoint._id,
        type: dto.type,
        target: dto.type === 'EMAIL' ? dto.target.toLowerCase() : dto.target,
        secret,
      });
      // The secret is shown exactly once, here, and only for webhooks. After this it can't be
      // read back. (A just-created document still carries the field, so drop it explicitly.)
      const json: Record<string, unknown> = { ...channel.toJSON() };
      delete json.secret;
      return secret ? { ...json, secret } : json;
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) {
        throw new ConflictException('This endpoint already has that channel');
      }
      throw err;
    }
  }

  async list(teamId: string, endpointId: string) {
    const endpoint = await this.ownedEndpoint(teamId, endpointId);
    return this.channels.find({ endpointId: endpoint._id }).sort({ createdAt: 1 });
  }

  async remove(teamId: string, id: string) {
    const channel = await this.owned(teamId, id);
    await this.channels.deleteOne({ _id: channel._id });
  }

  /** Sends a sample alert right now, so you can check the wiring without breaking anything. */
  async test(teamId: string, id: string) {
    const channel = await this.owned(teamId, id, true);
    const endpoint = await this.endpoints.findById(channel.endpointId);
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    try {
      await this.sender.send(
        { type: channel.type, target: channel.target, secret: channel.secret },
        buildTestPayload({ id: endpoint.id, name: endpoint.name, url: endpoint.url }, randomUUID()),
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async ownedEndpoint(teamId: string, id: string) {
    const endpoint = isObjectId(id) ? await this.endpoints.findOne({ _id: id, teamId }) : null;
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return endpoint;
  }

  private async owned(teamId: string, id: string, withSecret = false) {
    const query = isObjectId(id) ? this.channels.findOne({ _id: id, teamId }) : null;
    const channel = query ? await (withSecret ? query.select('+secret') : query) : null;
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }
}
