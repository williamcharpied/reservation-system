# Reservation System

Appointment booking system for Amour Nail Studio.

## Overview

A static booking site plus one Netlify Function. Customers pick a service and add-ons, choose an open time, and confirm. Bookings are stored in Netlify Blobs, so there is no separate database or third-party booking service.

## Features

- Online booking: service, add-ons, date and time, confirm
- Hardcoded availability: **Sundays and Mondays, 10 AM – 6 PM (Chicago time)**, start times every 30 minutes, one appointment at a time
- Double-booking protection (a taken time is never offered again)
- Customer manage page (`?manage=<token>`): cancel or reschedule from the emailed link, up to 24 hours before
- Staff page (`?staff`): look up bookings by ID, name or phone, cancel or reschedule, and a confirmation dashboard
- Confirmation, cancellation and reschedule emails (Resend) and SMS (Twilio)
- Optional write-only log of bookings to a Google Sheet
- Responsive design for mobile and desktop

## Project Structure

```
reservation-system/
├── index.html                      # Booking, manage and staff pages (single file)
├── package.json                    # Function dependency (@netlify/blobs)
├── netlify/
│   └── functions/
│       └── booking-api.mjs         # Availability, bookings, staff tools, SMS, reminders
├── netlify.toml                    # Netlify configuration
└── README.md                       # This file
```

## Services and Pricing

Edit the `SERVICES` and `ADDONS` lists near the top of the script in `index.html` (prices are in cents, durations in milliseconds).

## Availability

The hours are hardcoded in two places that must match:

- `netlify/functions/booking-api.mjs`: `OPEN_DAYS`, `OPEN_HOUR`, `CLOSE_HOUR`, `SLOT_STEP_MIN`, `MAX_CONCURRENT` (the server enforces these)
- `index.html`: `OPEN_DAYS` and `HOURS_TEXT` (controls which dates are shown)

## Data Storage

Bookings live in a Netlify Blobs store named `bookings`:

- `day/<YYYY-MM-DD>/<id>`: the booking, grouped by day
- `idx/<id>`: finds a booking from its ID

You can browse the store in the Netlify dashboard under Blobs. Cancelled bookings are kept (status `CANCELLED_*`) and free up their time slot.

## Getting Started

### Local Development

Static preview of the pages only: open `index.html` in a browser. The booking API needs Netlify, so run it with the Netlify CLI:

```bash
npm install
npx netlify dev
```

### Deployment

This project deploys to Netlify from the `reservation-system` repository.

1. Push changes to GitHub
2. Connect the repository to Netlify
3. Configure build settings:
   - Build command: (not required)
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
4. Set the environment variables below

### Environment Variables

Set these in your Netlify deployment settings:

| Variable | Required | Purpose |
| --- | --- | --- |
| `MANAGE_TOKEN_SECRET` | Yes | Long random string used to sign customer manage links |
| `STAFF_PASSWORD` | Yes | Password for the staff page |
| `SITE_URL` | Yes | Public site URL, used in emailed and texted links |
| `RESEND_API_KEY` | For email | Sends confirmation, cancellation and reschedule emails |
| `SALON_EMAIL` | No | Sender and add-on alert address (default `bookings@monalizanails.com`) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | For SMS | Text confirmations and reminders |
| `CRON_SECRET` | For reminders | Secret sent in the `X-Cron-Secret` header by the reminder job |
| `GOOGLE_SCRIPT_URL` | No | Optional Google Apps Script URL that logs bookings to a sheet |

## Integrations

- **Twilio inbound webhook** (YES to confirm, STOP to unsubscribe): `https://<your-site>/.netlify/functions/booking-api?path=/sms/inbound`
- **Daily reminder job** (for example cron-job.org, daily around 5 PM Chicago): `POST https://<your-site>/.netlify/functions/booking-api?path=/sms/reminders` with header `X-Cron-Secret: <CRON_SECRET>`. It texts customers whose appointment is two days away.

## Technologies

- HTML5 / CSS3 / JavaScript
- Netlify Functions and Netlify Blobs
- Resend (email) and Twilio (SMS)

## Support

For questions or issues, reach out to the development team.
