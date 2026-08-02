# Reservation System

Appointment booking system for Mona Liza Nails with Square payment integration.

## Overview

This is the core reservation/booking application that integrates with Square for payment processing. It provides an interface for customers to book nail appointments with real-time availability and secure payment handling.

## Features

- Appointment booking interface
- Square payment integration via proxy function
- Netlify Functions for backend operations
- Responsive design optimized for mobile and desktop

## Project Structure

```
reservation-system/
├── index.html                 # Main booking application
├── netlify/
│   └── functions/
│       └── square-proxy.js    # Square API proxy (Netlify Function)
├── netlify.toml              # Netlify deployment configuration
└── README.md                 # This file
```

## Getting Started

### Local Development

1. Open `index.html` in your browser for local preview
2. Install dependencies (if using build tools):
   ```bash
   npm install
   ```

### Deployment

This project deploys to Netlify from the `reservation-system` repository.

1. Push changes to GitHub
2. Connect the repository to Netlify
3. Configure build settings:
   - Build command: (not required for static files)
   - Publish directory: `.` (or root)
   - Functions directory: `netlify/functions`

### Environment Variables

Set these in your Netlify deployment settings:
- `SQUARE_ACCESS_TOKEN` - Your Square API access token
- Any other configuration specific to your Square account

## Square Integration

The `netlify/functions/square-proxy.js` function acts as a secure proxy between the frontend and Square's API. This prevents exposing your Square credentials on the client side.

## Technologies

- HTML5 / CSS3 / JavaScript
- Square API (via proxy)
- Netlify Functions
- Netlify Forms (if used)

## Support

For questions or issues, reach out to the development team.
