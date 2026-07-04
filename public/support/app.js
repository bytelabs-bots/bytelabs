const ticketForm = document.getElementById('ticket-form');
const statusEl = document.getElementById('ticket-status');
const ticketsList = document.getElementById('tickets-list');
const refreshBtn = document.getElementById('refresh-btn');

async function loadTickets() {
    try {
        const res = await fetch('/support/tickets');
        const data = await res.json();
        if (!Array.isArray(data)) {
            ticketsList.innerHTML = '<div class="card">Unable to load tickets.</div>';
            return;
        }

        if (!data.length) {
            ticketsList.innerHTML = '<div class="card">No tickets yet. Create the first one above.</div>';
            return;
        }

        ticketsList.innerHTML = data.map(ticket => `
            <div class="card" style="border-left: 4px solid ${getPriorityColor(ticket.priority)};">
                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                    <strong>#${ticket.id} · ${escapeHtml(ticket.subject)}</strong>
                    <span>${escapeHtml(ticket.status || 'open').toUpperCase()}</span>
                </div>
                <div style="margin-top:8px; color:#555;">
                    <div><b>From:</b> ${escapeHtml(ticket.name || 'Unknown')} (${escapeHtml(ticket.email || 'No email')})</div>
                    <div><b>Priority:</b> ${escapeHtml(ticket.priority || 'medium')}</div>
                    <div><b>Created:</b> ${escapeHtml(ticket.createdAt || 'now')}</div>
                </div>
                <p style="margin:10px 0 0; white-space:pre-wrap;">${escapeHtml(ticket.message || '')}</p>
                <div class="toolbar" style="margin-top:10px;">
                    <button type="button" onclick="updateTicketStatus(${ticket.id}, 'open')">Reopen</button>
                    <button type="button" onclick="updateTicketStatus(${ticket.id}, 'pending')">Pending</button>
                    <button type="button" onclick="updateTicketStatus(${ticket.id}, 'resolved')">Resolved</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        ticketsList.innerHTML = '<div class="card">Unable to load tickets.</div>';
    }
}

function getPriorityColor(priority) {
    switch (priority) {
        case 'urgent': return '#d62828';
        case 'high': return '#f77f00';
        case 'medium': return '#fcbf49';
        default: return '#2a9d8f';
    }
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

window.updateTicketStatus = async function(id, status) {
    try {
        const res = await fetch('/support/tickets/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (data.error) {
            statusEl.textContent = data.error;
            return;
        }
        statusEl.textContent = 'Ticket updated.';
        await loadTickets();
    } catch (error) {
        statusEl.textContent = 'Unable to update ticket.';
    }
};

if (ticketForm) {
    ticketForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        statusEl.textContent = 'Creating ticket...';

        const payload = {
            name: document.getElementById('ticket-name').value.trim(),
            email: document.getElementById('ticket-email').value.trim(),
            subject: document.getElementById('ticket-subject').value.trim(),
            priority: document.getElementById('ticket-priority').value,
            message: document.getElementById('ticket-message').value.trim()
        };

        try {
            const res = await fetch('/support/tickets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.error) {
                statusEl.textContent = data.error;
                return;
            }
            statusEl.textContent = `Ticket #${data.id} created successfully.`;
            ticketForm.reset();
            document.getElementById('ticket-priority').value = 'medium';
            await loadTickets();
        } catch (error) {
            statusEl.textContent = 'Unable to create ticket.';
        }
    });
}

if (refreshBtn) {
    refreshBtn.addEventListener('click', loadTickets);
}

loadTickets();
