import { Injectable } from '@angular/core';
import PocketBase from 'pocketbase';

function resolveApiUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8090';
  }
  return window.location.port === '4200' || window.location.port === '4217'
    ? 'http://127.0.0.1:8090'
    : window.location.origin;
}

@Injectable({ providedIn: 'root' })
export class PocketBaseService {
  readonly client = new PocketBase(resolveApiUrl());

  constructor() {
    this.client.autoCancellation(false);
  }
}
