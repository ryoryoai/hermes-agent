import { PassThrough } from 'stream'

import { renderSync } from '@hermes/ink'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

// Stub useInput so the overlay doesn't try to enter raw mode under renderSync
// (PassThrough stdin doesn't support it). Box/Text pass through to real Ink.
vi.mock('@hermes/ink', async importOriginal => {
  const mod = await importOriginal()

  return {
    ...mod,
    useInput: () => {}
  }
})

import type { SubscriptionOverlayState } from '../app/interfaces.js'
import { SubscriptionOverlay } from '../components/subscriptionOverlay.js'
import type { SubscriptionStateResponse, SubscriptionTierOption } from '../gatewayTypes.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

const t = DEFAULT_THEME

/** Render a SubscriptionOverlay to a string via renderSync + PassThrough. */
function render(overlay: SubscriptionOverlayState): string {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()

  let output = ''

  Object.assign(stdout, { columns: 100, isTTY: false, rows: 40 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = renderSync(
    React.createElement(SubscriptionOverlay, {
      onClose: () => {},
      onPatch: () => {},
      overlay,
      t
    }),
    {
      patchConsole: false,
      stderr: stderr as NodeJS.WriteStream,
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream
    }
  )

  instance.unmount()
  instance.cleanup()

  return stripAnsi(output)
}

const tier = (overrides: Partial<SubscriptionTierOption> = {}): SubscriptionTierOption => ({
  tier_id: 'free',
  name: 'Free',
  tier_order: 0,
  dollars_per_month_display: '$0',
  monthly_credits: '0',
  is_current: false,
  is_enabled: true,
  ...overrides
})

const state = (overrides: Partial<SubscriptionStateResponse> = {}): SubscriptionStateResponse => ({
  ok: true,
  logged_in: true,
  is_admin: true,
  can_change_plan: true,
  org_name: 'Acme',
  org_id: 'org_acme',
  role: 'OWNER',
  current: null,
  tiers: [],
  portal_url: 'https://portal.nousresearch.com/billing',
  ...overrides
})

const ctx = {
  openManageLink: vi.fn(() => Promise.resolve(true)),
  refreshState: vi.fn(() => Promise.resolve(null)),
  requestRemoteSpending: vi.fn(() => Promise.resolve(true)),
  sys: vi.fn()
}

const overlay = (s: SubscriptionStateResponse, screen: SubscriptionOverlayState['screen'] = 'overview'): SubscriptionOverlayState => ({
  ctx,
  screen,
  state: s,
  resumeScreen: null,
  pendingTargetTierId: null
})

describe('SubscriptionOverlay — overview screen', () => {
  it('(a) free-upgradeable: shows tier list + subscribe header', () => {
    const s = state({
      current: null,
      tiers: [
        tier({ tier_id: 'free', name: 'Free', tier_order: 0, dollars_per_month_display: '$0', monthly_credits: '0' }),
        tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, dollars_per_month_display: '$20', monthly_credits: '1000', is_current: false }),
        tier({ tier_id: 'scale', name: 'Scale', tier_order: 2, dollars_per_month_display: '$99', monthly_credits: '5000', is_current: false })
      ]
    })

    const out = render(overlay(s))

    expect(out).toContain('Subscribe to a plan')
    expect(out).toContain('Pro')
    expect(out).toContain('Scale')
    expect(out).toContain('$20')
    expect(out).toContain('1000 credits')
  })

  it('(b) subscriber mid-tier: shows current plan + usage bar', () => {
    const s = state({
      current: {
        tier_id: 'pro',
        tier_name: 'Pro',
        monthly_credits: '1000',
        credits_remaining: '420',
        cycle_ends_at: '2026-07-01T00:00:00Z',
        pending_downgrade_tier_name: null,
        pending_downgrade_at: null,
        is_past_due: false
      },
      tiers: [
        tier({ tier_id: 'free', name: 'Free', tier_order: 0 }),
        tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, dollars_per_month_display: '$20', monthly_credits: '1000', is_current: true }),
        tier({ tier_id: 'scale', name: 'Scale', tier_order: 2, dollars_per_month_display: '$99', monthly_credits: '5000' })
      ]
    })

    const out = render(overlay(s))

    expect(out).toContain('Your plan: Pro')
    expect(out).toContain('remaining')
    expect(out).toContain('Scale')
  })

  it('(c) subscriber top-tier: shows top plan note', () => {
    const s = state({
      current: {
        tier_id: 'scale',
        tier_name: 'Scale',
        monthly_credits: '5000',
        credits_remaining: '3000',
        cycle_ends_at: '2026-07-01T00:00:00Z',
        pending_downgrade_tier_name: null,
        pending_downgrade_at: null,
        is_past_due: false
      },
      tiers: [
        tier({ tier_id: 'free', name: 'Free', tier_order: 0 }),
        tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, is_current: false }),
        tier({ tier_id: 'scale', name: 'Scale', tier_order: 2, dollars_per_month_display: '$99', monthly_credits: '5000', is_current: true })
      ]
    })

    const out = render(overlay(s))

    expect(out).toContain('Your plan: Scale')
    expect(out).toContain("You're on the top plan.")
  })

  it('(d) not-admin: shows read-only note + no tier list', () => {
    const s = state({
      is_admin: false,
      can_change_plan: false,
      role: 'MEMBER',
      current: {
        tier_id: 'pro',
        tier_name: 'Pro',
        monthly_credits: '1000',
        credits_remaining: '500',
        cycle_ends_at: '2026-07-01T00:00:00Z',
        pending_downgrade_tier_name: null,
        pending_downgrade_at: null,
        is_past_due: false
      },
      tiers: [tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, is_current: true })]
    })

    const out = render(overlay(s))

    expect(out).toContain('Plan changes need an org admin/owner.')
    expect(out).toContain('Manage on portal')
  })

  it('(e) downgrade-pending: shows scheduled switch banner', () => {
    const s = state({
      current: {
        tier_id: 'pro',
        tier_name: 'Pro',
        monthly_credits: '1000',
        credits_remaining: '500',
        cycle_ends_at: '2026-07-01T00:00:00Z',
        pending_downgrade_tier_name: 'Free',
        pending_downgrade_at: '2026-07-15T00:00:00Z',
        is_past_due: false
      },
      tiers: [
        tier({ tier_id: 'free', name: 'Free', tier_order: 0 }),
        tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, is_current: true })
      ]
    })

    const out = render(overlay(s))

    expect(out).toContain('Scheduled to switch to Free')
    expect(out).toContain('2026-07-15T00:00:00Z')
  })

  it('dunning: past due shows past-due banner (does NOT re-offer fresh subscribe)', () => {
    const s = state({
      current: {
        tier_id: 'pro',
        tier_name: 'Pro',
        monthly_credits: '1000',
        credits_remaining: '500',
        cycle_ends_at: '2026-07-01T00:00:00Z',
        pending_downgrade_tier_name: null,
        pending_downgrade_at: null,
        is_past_due: true
      },
      tiers: [tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, is_current: true })]
    })

    const out = render(overlay(s))

    expect(out).toContain('Payment past due')
    expect(out).toContain('still active until')
    expect(out).toContain('2026-07-01T00:00:00Z')
  })
})

describe('SubscriptionOverlay — confirm screen', () => {
  it('shows tier summary + Stripe disclosure', () => {
    const s = state({
      current: null,
      tiers: [tier({ tier_id: 'pro', name: 'Pro', tier_order: 1, dollars_per_month_display: '$20', monthly_credits: '1000' })]
    })

    const out = render({ ...overlay(s, 'confirm'), pendingTargetTierId: 'pro' })

    expect(out).toContain('Confirm subscription')
    expect(out).toContain('Pro')
    expect(out).toContain('$20')
    expect(out).toContain('securely on your subscription page')
    expect(out).toContain('Continue to your subscription page')
  })
})

describe('SubscriptionOverlay — handoff screen', () => {
  it('shows opening-stripe copy', () => {
    const out = render(overlay(state(), 'handoff'))

    expect(out).toContain('Opening Stripe')
    expect(out).toContain('browser')
    expect(out).toContain('Re-run /subscription')
  })
})
