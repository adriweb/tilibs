/* Hey EMACS -*- linux-c -*- */
/* $Id$ */

/*  libticalcs - Ti Calculator library, a part of the TiLP project
 *  Copyright (C) 1999-2005  Romain Li�vin
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program; if not, write to the Free Software
 *  Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA 02111-1307, USA.
 */

#ifndef __TICALCS_CMD89T__
#define __TICALCS_CMD89T__

// Data Types (or opcodes)

#define TI89T_OPC_NONE		0x0000
#define TI89T_OPC_SCR1		0x0001
#define TI89T_OPC_SCR2		0x0007

int ti89t_send_handshake(CalcHandle *h);
int ti89t_recv_response (CalcHandle *h);
int ti89t_send_data(CalcHandle *h, uint32_t  size, uint16_t  code, uint8_t *data);
int ti89t_recv_data(CalcHandle *h, uint32_t *size, uint16_t *code, uint8_t *data);
int ti89t_send_acknowledge(CalcHandle* h);
int ti89t_recv_acknowledge(CalcHandle *h);

#endif